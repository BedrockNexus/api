import type { Context } from 'hono'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { catalogOpenApiDocument } from '../lib/catalog-openapi'
import {
	type CategoryDoc,
	type ContentDoc,
	type ContentReleaseDoc,
	type GameVersionDoc,
	type LatestReleaseDoc,
	type PluginCardDoc,
	type PluginDoc,
	type ServerDoc,
	type SoftwareDoc,
	toCategoryView,
	toContentDetail,
	toContentRelease,
	toContentSummary,
	toContentType,
	toGameVersionView,
	toPluginDetail,
	toPluginRelease,
	toPluginSummary,
	toServerDetail,
	toServerSummary,
	toSoftwareView,
	toUpdateView,
} from '../lib/catalog-views'
import { ConvexMutationError } from '../lib/convex-mutation'
import {
	type ConvexQuery,
	ConvexQueryError,
	ConvexUnavailableError,
} from '../lib/convex-query'

const DEFAULT_PAGE_SIZE = 24
// Hub's listing queries return at most this many per page.
const MAX_PAGE_SIZE = 48
const MAX_SEARCH_LENGTH = 100
const MAX_CURSOR_LENGTH = 4096
const MAX_FILTER_VALUES = 20
const MAX_FILTER_VALUE_LENGTH = 64
const MAX_REFERENCE_LENGTH = 256

const CONTENT_SORTS = [
	'downloads',
	'trending',
	'updated',
	'newest',
	'rating',
	'saved',
] as const
const RESOURCE_PACK_RESOLUTIONS = [
	'8x',
	'16x',
	'32x',
	'64x',
	'128x',
	'256x',
	'512x',
	'custom',
] as const
const PLUGIN_SORTS = ['latest', 'rating'] as const
const SERVER_SORTS = [
	'players',
	'trending',
	'rating',
	'newest',
	'saved',
] as const
const SERVER_STATUSES = ['online', 'offline'] as const
const UPDATE_SECTIONS = ['addons', 'resource-packs', 'plugins'] as const
const MAX_UPDATE_ITEMS = 100
const MAX_UPDATE_BODY_BYTES = 64 * 1024
const MAX_VERSION_LENGTH = 100

/** Add-ons and resource packs share Hub's queries but are separate sections. */
const CONTENT_SECTIONS = [
	{
		categoriesPath: '/addon-categories',
		label: 'Add-on',
		path: '/addons',
		type: 'addon',
	},
	{
		categoriesPath: '/resource-pack-categories',
		label: 'Resource pack',
		path: '/resource-packs',
		type: 'resource_pack',
	},
] as const

const QUERIES = {
	contentBrowse: 'functions/projects/listing:browse',
	contentCategories: 'functions/projects/categories:list',
	contentGet: 'functions/projects/projects:getPublishedBySlug',
	contentLatestRelease: 'functions/projects/versions:getLatest',
	contentRelease: 'functions/projects/versions:getPublicByVersion',
	contentReleases: 'functions/projects/versions:listPublic',
	features: 'functions/site/settings:getFeatures',
	gameVersions: 'functions/site/gameVersions:listActive',
	latestReleases: 'functions/site/releases:latest',
	pluginBrowse: 'functions/plugins/catalog:explore',
	pluginCategories: 'functions/plugins/categories:list',
	pluginGet: 'functions/plugins/catalog:getProject',
	serverBrowse: 'functions/servers/listing:browse',
	serverCategories: 'functions/servers/categories:list',
	serverGet: 'functions/servers/servers:getPublishedBySlug',
	serverSoftware: 'functions/servers/software:listEnabled',
} as const

// Live status changes every few minutes; the taxonomy rarely changes at all.
const LIVE_CACHE = 'public, max-age=30'
const CONTENT_CACHE = 'public, max-age=60'
const TAXONOMY_CACHE = 'public, max-age=300'

class CatalogError extends Error {
	readonly code: string
	readonly status: 400 | 404 | 503

	constructor(status: 400 | 404 | 503, code: string, message: string) {
		super(message)
		this.code = code
		this.status = status
	}
}

function invalidParameter(name: string, message: string) {
	return new CatalogError(400, 'INVALID_PARAMETER', `${name}: ${message}`)
}

function notFound(resource: string) {
	return new CatalogError(404, 'NOT_FOUND', `${resource} not found`)
}

function readEnum<Value extends string>(
	c: Context,
	name: string,
	allowed: readonly Value[],
) {
	const value = c.req.query(name)
	if (value === undefined) {
		return undefined
	}
	if (!allowed.includes(value as Value)) {
		throw invalidParameter(name, `must be one of ${allowed.join(', ')}`)
	}
	return value as Value
}

/** A repeatable parameter: `?category=a&category=b`. */
function readValues(c: Context, name: string) {
	const values = (c.req.queries(name) ?? [])
		.map((value) => value.trim())
		.filter(Boolean)
	if (values.length > MAX_FILTER_VALUES) {
		throw invalidParameter(name, `accepts at most ${MAX_FILTER_VALUES} values`)
	}
	if (values.some((value) => value.length > MAX_FILTER_VALUE_LENGTH)) {
		throw invalidParameter(name, 'value is too long')
	}
	return values.length > 0 ? [...new Set(values)] : undefined
}

function readEnumValues<Value extends string>(
	c: Context,
	name: string,
	allowed: readonly Value[],
) {
	const values = readValues(c, name)
	if (values?.some((value) => !allowed.includes(value as Value))) {
		throw invalidParameter(name, `must be one of ${allowed.join(', ')}`)
	}
	return values as Value[] | undefined
}

function readPagination(c: Context) {
	const rawLimit = c.req.query('limit')
	const limit = rawLimit === undefined ? DEFAULT_PAGE_SIZE : Number(rawLimit)
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
		throw invalidParameter('limit', `must be between 1 and ${MAX_PAGE_SIZE}`)
	}

	const cursor = c.req.query('cursor') || null
	if (cursor && cursor.length > MAX_CURSOR_LENGTH) {
		throw invalidParameter('cursor', 'is not valid')
	}
	return { cursor, limit }
}

function readSearch(c: Context) {
	const query = c.req.query('q')?.trim()
	if (query && query.length > MAX_SEARCH_LENGTH) {
		throw invalidParameter(
			'q',
			`must be at most ${MAX_SEARCH_LENGTH} characters`,
		)
	}
	return query || undefined
}

function readReference(c: Context, resource: string) {
	const reference = c.req.param('reference') ?? ''
	if (!reference || reference.length > MAX_REFERENCE_LENGTH) {
		throw notFound(resource)
	}
	return reference
}

interface UpdateItem {
	id: string
	section: (typeof UPDATE_SECTIONS)[number]
	version?: string
}

function readUpdateItems(body: unknown): UpdateItem[] {
	const items = (body as { items?: unknown } | null)?.items
	if (!Array.isArray(items) || items.length === 0) {
		throw invalidParameter('items', 'must be a non-empty array')
	}
	if (items.length > MAX_UPDATE_ITEMS) {
		throw invalidParameter(
			'items',
			`accepts at most ${MAX_UPDATE_ITEMS} entries`,
		)
	}
	return items.map((item: unknown, index) => {
		const { id, section, version } = (item ?? {}) as Record<string, unknown>
		const name = `items[${index}]`
		if (!UPDATE_SECTIONS.includes(section as UpdateItem['section'])) {
			throw invalidParameter(
				name,
				`section must be one of ${UPDATE_SECTIONS.join(', ')}`,
			)
		}
		if (typeof id !== 'string' || !id || id.length > MAX_REFERENCE_LENGTH) {
			throw invalidParameter(name, 'id must be a stable ID or slug')
		}
		if (
			version !== undefined &&
			(typeof version !== 'string' ||
				!version ||
				version.length > MAX_VERSION_LENGTH)
		) {
			throw invalidParameter(name, 'version must be a version string')
		}
		return {
			id,
			section: section as UpdateItem['section'],
			version: version as string | undefined,
		}
	})
}

interface BrowsePage<Doc> {
	continueCursor: string
	isDone: boolean
	page: Doc[]
}

export function createCatalogRoutes(options: {
	hubUrl: string
	apiUrl?: string
	downloadSecret?: string
	mutation?: ConvexQuery
	clientKey?: (headers: Headers) => string
	query?: ConvexQuery
}) {
	const { hubUrl, query } = options
	const apiUrl = options.apiUrl ?? 'https://api.bedrocknexus.com'
	const app = new Hono()

	const runQuery: ConvexQuery = async (path, args) => {
		if (!query) {
			throw new CatalogError(
				503,
				'CATALOG_UNAVAILABLE',
				'The catalog is not configured on this API instance',
			)
		}
		return await query(path, args)
	}

	async function download(
		c: Context,
		path: string,
		args: Record<string, unknown>,
	) {
		c.header('Cache-Control', 'private, no-store, max-age=0')
		if (c.req.method === 'HEAD') return c.body(null, 405, { Allow: 'GET' })
		if (!options.downloadSecret || !options.mutation || !options.clientKey) {
			return c.json(
				{
					error: {
						code: 'DOWNLOAD_UNAVAILABLE',
						message: 'Downloads are not configured',
					},
				},
				503,
			)
		}
		const result = await options.mutation<{
			ok?: boolean
			code?: string
			message?: string
			url?: string
			counted?: boolean
		}>(path, { ...args, source: 'api' })
		if (result.ok === false || !result.url) {
			const status =
				result.code === 'FILE_MISSING'
					? 410
					: result.code === 'VERSION_PROCESSING' ||
							result.code === 'VERSION_NOT_VALIDATED'
						? 409
						: 404
			return c.json(
				{
					error: {
						code: result.code ?? 'NOT_FOUND',
						message: result.message ?? 'Download not found',
					},
				},
				status,
			)
		}
		if (result.counted !== undefined)
			c.header('X-BedrockNexus-Download-Counted', result.counted ? '1' : '0')
		return c.redirect(result.url, 307)
	}

	/** Runs a listing query. Only a cursor can make these fail on their input. */
	async function browse<Doc>(
		path: string,
		pagination: { cursor: string | null; limit: number },
		args: Record<string, unknown>,
	) {
		try {
			return await runQuery<BrowsePage<Doc>>(path, {
				...args,
				paginationOpts: {
					cursor: pagination.cursor,
					numItems: pagination.limit,
				},
			})
		} catch (error) {
			if (pagination.cursor && error instanceof ConvexQueryError) {
				throw invalidParameter('cursor', 'is not valid')
			}
			throw error
		}
	}

	function toPage<Doc, View>(
		result: BrowsePage<Doc>,
		toView: (doc: Doc) => View,
	) {
		return {
			data: result.page.map(toView),
			pagination: {
				hasMore: !result.isDone,
				nextCursor: result.isDone ? null : result.continueCursor,
			},
		}
	}

	/** Resolves slugs to IDs, refusing any slug that is not a category. */
	function resolveCategories(categories: CategoryDoc[], slugs: string[]) {
		return slugs.flatMap((slug) => {
			const matches = categories.filter((category) => category.slug === slug)
			if (matches.length === 0) {
				throw invalidParameter('category', `unknown category "${slug}"`)
			}
			return matches.map((category) => category._id)
		})
	}

	for (const section of CONTENT_SECTIONS) {
		const { categoriesPath, label, path, type } = section

		/** Hub resolves any project, so the section is enforced here. */
		const getContent = async (reference: string) => {
			const content = await runQuery<ContentDoc | null>(QUERIES.contentGet, {
				slug: reference,
			})
			if (!content || toContentType(content.type) !== type) {
				throw notFound(label)
			}
			return content
		}

		app.get(path, async (c) => {
			const pagination = readPagination(c)
			const categorySlugs = readValues(c, 'category')
			const args = {
				gameVersions: readValues(c, 'gameVersion'),
				query: readSearch(c),
				resourcePackResolutions:
					type === 'resource_pack'
						? readEnumValues(c, 'resolution', RESOURCE_PACK_RESOLUTIONS)
						: undefined,
				sort: readEnum(c, 'sort', CONTENT_SORTS),
				type,
			}
			const categoryIds = categorySlugs
				? resolveCategories(
						await runQuery<CategoryDoc[]>(QUERIES.contentCategories, {
							projectType: type,
						}),
						categorySlugs,
					)
				: undefined

			const result = await browse<ContentDoc>(
				QUERIES.contentBrowse,
				pagination,
				{ ...args, categoryIds },
			)
			c.header('Cache-Control', CONTENT_CACHE)
			return c.json(
				toPage(result, (content) => toContentSummary(content, hubUrl)),
			)
		})

		app.get(`${path}/:reference`, async (c) => {
			const content = await getContent(readReference(c, label))
			c.header('Cache-Control', CONTENT_CACHE)
			return c.json({ data: toContentDetail(content, hubUrl) })
		})

		app.get(`${path}/:reference/releases`, async (c) => {
			const content = await getContent(readReference(c, label))
			const releases = await runQuery<ContentReleaseDoc[]>(
				QUERIES.contentReleases,
				{ projectId: content._id },
			)
			c.header('Cache-Control', CONTENT_CACHE)
			return c.json({
				data: releases.map((release) =>
					toContentRelease(release, apiUrl, path.slice(1), content._id),
				),
			})
		})

		// Registered before `:version`, which would otherwise match "latest".
		app.get(`${path}/:reference/releases/latest`, async (c) => {
			const content = await getContent(readReference(c, label))
			const release = await runQuery<ContentReleaseDoc | null>(
				QUERIES.contentLatestRelease,
				{ projectId: content._id },
			)
			if (!release) {
				throw notFound('Release')
			}
			c.header('Cache-Control', CONTENT_CACHE)
			return c.json({
				data: toContentRelease(release, apiUrl, path.slice(1), content._id),
			})
		})

		app.get(`${path}/:reference/releases/:version`, async (c) => {
			const release = await runQuery<ContentReleaseDoc | null>(
				QUERIES.contentRelease,
				{
					slug: readReference(c, label),
					version: c.req.param('version') ?? '',
				},
			)
			if (!release || toContentType(release.project?.type ?? '') !== type) {
				throw notFound('Release')
			}
			c.header('Cache-Control', CONTENT_CACHE)
			return c.json({
				data: toContentRelease(
					release,
					apiUrl,
					path.slice(1),
					release.project?.reference ?? readReference(c, label),
				),
			})
		})

		app.get(categoriesPath, async (c) => {
			const categories = await runQuery<CategoryDoc[]>(
				QUERIES.contentCategories,
				{ projectType: type },
			)
			c.header('Cache-Control', TAXONOMY_CACHE)
			return c.json({ data: categories.map(toCategoryView) })
		})

		app.on(
			['GET', 'HEAD'],
			`${path}/:reference/releases/:version/download`,
			async (c) => {
				if (c.req.method === 'HEAD')
					return c.body(null, 405, {
						Allow: 'GET',
						'Cache-Control': 'no-store',
					})
				const content = await getContent(readReference(c, label))
				const requested = c.req.param('version') ?? ''
				if (!requested || requested.length > MAX_VERSION_LENGTH)
					throw notFound('Release')
				const release =
					requested === 'latest'
						? await runQuery<ContentReleaseDoc | null>(
								QUERIES.contentLatestRelease,
								{ projectId: content._id },
							)
						: await runQuery<ContentReleaseDoc | null>(QUERIES.contentRelease, {
								slug: readReference(c, label),
								version: requested,
							})
				if (
					!release ||
					(release.project && toContentType(release.project.type) !== type)
				)
					throw notFound('Release')
				return await download(
					c,
					'functions/projects/versions:createDownloadUrl',
					{
						versionId: release._id,
						downloadSecret: options.downloadSecret,
						clientKey: options.clientKey?.(c.req.raw.headers),
					},
				)
			},
		)
	}

	// The plugin registry can be switched off site-wide; Hub hides its pages then.
	const requirePluginsEnabled = async (
		_c: Context,
		next: () => Promise<void>,
	) => {
		const features = await runQuery<{ pluginsEnabled?: boolean }>(
			QUERIES.features,
		)
		if (features.pluginsEnabled !== true) {
			throw new CatalogError(404, 'NOT_FOUND', 'Plugins are not available')
		}
		await next()
	}
	// Also matches `/plugins` itself.
	app.use('/plugins/*', requirePluginsEnabled)
	app.use('/plugin-categories', requirePluginsEnabled)

	async function getPlugin(reference: string) {
		const plugin = await runQuery<PluginDoc | null>(QUERIES.pluginGet, {
			slug: reference,
		})
		if (!plugin) {
			throw notFound('Plugin')
		}
		return plugin
	}

	app.get('/plugins', async (c) => {
		const pagination = readPagination(c)
		const categorySlugs = readValues(c, 'category')
		const args = {
			search: readSearch(c),
			softwareSlugs: readValues(c, 'software'),
			sort: readEnum(c, 'sort', PLUGIN_SORTS) ?? 'latest',
		}
		// Hub ignores unknown categories beside known ones, widening the results.
		if (categorySlugs) {
			resolveCategories(
				await runQuery<CategoryDoc[]>(QUERIES.pluginCategories),
				categorySlugs,
			)
		}

		const result = await browse<PluginCardDoc>(
			QUERIES.pluginBrowse,
			pagination,
			{ ...args, categorySlugs },
		)
		c.header('Cache-Control', CONTENT_CACHE)
		return c.json(toPage(result, (plugin) => toPluginSummary(plugin, hubUrl)))
	})

	app.get('/plugins/:reference', async (c) => {
		const plugin = await getPlugin(readReference(c, 'Plugin'))
		c.header('Cache-Control', CONTENT_CACHE)
		return c.json({ data: toPluginDetail(plugin, hubUrl) })
	})

	app.get('/plugins/:reference/releases', async (c) => {
		const plugin = await getPlugin(readReference(c, 'Plugin'))
		c.header('Cache-Control', CONTENT_CACHE)
		return c.json({
			data: plugin.versions.map((version) =>
				toPluginRelease(plugin.project.publicId, version, apiUrl),
			),
		})
	})

	// Registered before `:version`, which would otherwise match "latest".
	app.get('/plugins/:reference/releases/latest', async (c) => {
		const plugin = await getPlugin(readReference(c, 'Plugin'))
		const latest = plugin.project.latestVersion?.version
		const version = plugin.versions.find((item) => item.version === latest)
		if (!version) {
			throw notFound('Release')
		}
		c.header('Cache-Control', CONTENT_CACHE)
		return c.json({
			data: toPluginRelease(plugin.project.publicId, version, apiUrl),
		})
	})

	app.get('/plugins/:reference/releases/:version', async (c) => {
		const plugin = await getPlugin(readReference(c, 'Plugin'))
		const requested = c.req.param('version')
		const version = plugin.versions.find(
			(item) =>
				item.version === requested || item.normalizedVersion === requested,
		)
		if (!version) {
			throw notFound('Release')
		}
		c.header('Cache-Control', CONTENT_CACHE)
		return c.json({
			data: toPluginRelease(plugin.project.publicId, version, apiUrl),
		})
	})

	app.get('/plugin-categories', async (c) => {
		const categories = await runQuery<CategoryDoc[]>(QUERIES.pluginCategories)
		c.header('Cache-Control', TAXONOMY_CACHE)
		return c.json({ data: categories.map(toCategoryView) })
	})

	app.on(
		['GET', 'HEAD'],
		'/plugins/:reference/releases/:version/download',
		async (c) => {
			if (c.req.method === 'HEAD')
				return c.body(null, 405, { Allow: 'GET', 'Cache-Control': 'no-store' })
			const plugin = await getPlugin(readReference(c, 'Plugin'))
			const requested = c.req.param('version')
			const selected =
				requested === 'latest'
					? plugin.project.latestVersion?.version
					: requested
			const version = plugin.versions.find(
				(item) =>
					item.version === selected || item.normalizedVersion === selected,
			)
			if (!version?.release?.asset) throw notFound('Release')
			return await download(c, 'functions/plugins/downloads:resolveAndRecord', {
				projectSlug: plugin.project.publicId,
				version: version.normalizedVersion,
				anonymousIdHash: options.clientKey?.(c.req.raw.headers),
				redirectSecret: options.downloadSecret,
			})
		},
	)

	app.get('/servers', async (c) => {
		const pagination = readPagination(c)
		const status = readEnum(c, 'status', SERVER_STATUSES)
		const categorySlugs = readValues(c, 'category')
		const args = {
			gameVersions: readValues(c, 'gameVersion'),
			query: readSearch(c),
			regions: readValues(c, 'region'),
			software: readValues(c, 'software')?.[0],
			sort: readEnum(c, 'sort', SERVER_SORTS),
			status: status ? [status] : undefined,
		}
		// Hub ignores unknown server categories, which would widen the results.
		if (categorySlugs) {
			resolveCategories(
				await runQuery<CategoryDoc[]>(QUERIES.serverCategories),
				categorySlugs,
			)
		}

		const result = await browse<ServerDoc>(QUERIES.serverBrowse, pagination, {
			...args,
			categories: categorySlugs,
		})
		c.header('Cache-Control', LIVE_CACHE)
		return c.json(toPage(result, (server) => toServerSummary(server, hubUrl)))
	})

	app.get('/servers/:reference', async (c) => {
		const server = await runQuery<ServerDoc | null>(QUERIES.serverGet, {
			slug: readReference(c, 'Server'),
		})
		if (!server) {
			throw notFound('Server')
		}
		c.header('Cache-Control', LIVE_CACHE)
		return c.json({ data: toServerDetail(server, hubUrl) })
	})

	app.get('/server-categories', async (c) => {
		const categories = await runQuery<CategoryDoc[]>(QUERIES.serverCategories)
		c.header('Cache-Control', TAXONOMY_CACHE)
		return c.json({ data: categories.map(toCategoryView) })
	})

	app.get('/server-software', async (c) => {
		const software = await runQuery<SoftwareDoc[]>(QUERIES.serverSoftware)
		c.header('Cache-Control', TAXONOMY_CACHE)
		return c.json({ data: software.map(toSoftwareView) })
	})

	app.get('/game-versions', async (c) => {
		const versions = await runQuery<GameVersionDoc[]>(QUERIES.gameVersions)
		c.header('Cache-Control', TAXONOMY_CACHE)
		return c.json({ data: versions.map(toGameVersionView) })
	})

	app.post(
		'/updates',
		bodyLimit({
			maxSize: MAX_UPDATE_BODY_BYTES,
			onError: () => {
				throw invalidParameter('items', 'the request is too large')
			},
		}),
		async (c) => {
			const items = readUpdateItems(await c.req.json().catch(() => null))
			const latest = await runQuery<LatestReleaseDoc[]>(
				QUERIES.latestReleases,
				{
					items: items.map(({ id, section }) => ({
						reference: id,
						section,
					})),
				},
			)
			c.header('Cache-Control', 'no-store')
			return c.json({
				data: items.map((item, index) =>
					toUpdateView(item, latest[index] ?? null, apiUrl),
				),
			})
		},
	)

	app.get('/openapi.json', (c) => {
		c.header('Cache-Control', TAXONOMY_CACHE)
		return c.json(catalogOpenApiDocument)
	})

	// Mounted sub-apps do not get their own notFound handler.
	app.all('*', () => {
		throw new CatalogError(404, 'NOT_FOUND', 'Endpoint not found')
	})

	app.onError((error, c) => {
		c.header('Cache-Control', 'no-store')
		if (error instanceof ConvexMutationError) {
			const data = error.data as {
				code?: string
				retryAfterMs?: number
				retryAfter?: number
			} | null
			if (
				data?.code === 'RATE_LIMITED' ||
				data?.code === 'DOWNLOAD_RATE_LIMITED'
			) {
				const ms = data.retryAfterMs ?? data.retryAfter ?? 1000
				c.header('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))))
				return c.json(
					{
						error: {
							code: 'DOWNLOAD_RATE_LIMITED',
							message: 'Too many download requests',
						},
					},
					429,
				)
			}
			if (data?.code === 'DOWNLOAD_NOT_FOUND')
				return c.json(
					{ error: { code: 'NOT_FOUND', message: 'Download not found' } },
					404,
				)
			return c.json(
				{
					error: {
						code: 'DOWNLOAD_UNAVAILABLE',
						message: 'Downloads are temporarily unavailable',
					},
				},
				503,
			)
		}
		if (error instanceof CatalogError) {
			return c.json(
				{ error: { code: error.code, message: error.message } },
				error.status,
			)
		}

		console.error('Catalog request failed', error)
		const unavailable =
			error instanceof ConvexUnavailableError ||
			error instanceof ConvexQueryError
		return c.json(
			{
				error: {
					code: unavailable ? 'CATALOG_UNAVAILABLE' : 'INTERNAL_ERROR',
					message: unavailable
						? 'The catalog is temporarily unavailable'
						: 'Internal server error',
				},
			},
			unavailable ? 503 : 500,
		)
	})

	return app
}
