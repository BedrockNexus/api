import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import type { AppConfig } from '../src/config'
import { catalogOpenApiDocument } from '../src/lib/catalog-openapi'
import {
	ConvexQueryError,
	ConvexUnavailableError,
} from '../src/lib/convex-query'
import { createCatalogRoutes } from '../src/routes/catalog'

const HUB_URL = 'https://hub.example.test'

// Every private field carries this marker, so one check can catch any leak.
const SECRET = 'PRIVATE-VALUE'
const privateFields = {
	_creationTime: 1,
	addressKey: SECRET,
	bannerR2Key: SECRET,
	createdBy: SECRET,
	iconR2Key: SECRET,
	logoR2Key: SECRET,
	moderatedBy: SECRET,
	moderationReason: SECRET,
	moderationStatus: SECRET,
	ownerId: SECRET,
	registeredBy: SECRET,
	searchText: SECRET,
	validationReport: SECRET,
	verificationMethod: SECRET,
	verifiedBy: SECRET,
}

const addonCategory = {
	...privateFields,
	_id: 'cat1',
	description: 'Creatures',
	name: 'Mobs',
	projectType: 'addon',
	slug: 'mobs',
}
const addon = {
	...privateFields,
	_id: 'addon1',
	categories: [addonCategory],
	credits: [{ name: 'Ann', role: 'Art', url: undefined, userId: SECRET }],
	description: 'Long text',
	latestVersionString: '1.0.0',
	metadata: {
		behaviorPackIncluded: true,
		dependencies: [{ name: 'Lib', secretField: SECRET }],
		experimentalFeaturesRequired: false,
		resourcePackIncluded: false,
		secretField: SECRET,
		type: 'addon',
	},
	name: 'Dragons',
	owner: {
		logo: 'logo.png',
		members: [{ username: SECRET }],
		name: 'Org',
		slug: 'org',
		type: 'organization',
	},
	slug: 'dragons',
	summary: 'Short text',
	supportedGameVersions: ['1.26.60'],
	type: 'addon',
	updatedAt: 1_700_000_000_000,
}
// Stored before the rename from texture pack, as older documents still are.
const resourcePack = {
	...addon,
	_id: 'pack1',
	metadata: {
		contentTypes: ['textures'],
		resolution: '16x',
		secretField: SECRET,
		type: 'resource_pack',
	},
	name: 'Pack',
	slug: 'pack',
	type: 'texture_pack',
}
const contentRelease = {
	...privateFields,
	_id: 'rel1',
	changelog: 'Notes',
	createdAt: 1_700_000_000_000,
	downloads: 3,
	downloadUrl: '/api/projects/versions/rel1/download',
	fileName: 'dragons.mcaddon',
	fileSize: 10,
	gameVersions: ['1.26.60'],
	r2Key: SECRET,
	version: '1.0.0',
}
const pluginCard = {
	...privateFields,
	categories: [{ name: 'Economy', secretField: SECRET, slug: 'economy' }],
	creator: {
		avatarUrl: 'a.png',
		displayName: 'Ann',
		secretField: SECRET,
		username: 'ann',
	},
	iconUrl: 'icon.png',
	latestVersion: {
		publishedAt: 1_700_000_000_000,
		verifiedBuild: true,
		version: 'v1.1.0',
	},
	license: 'MIT',
	name: 'Economy',
	organization: null,
	projectId: SECRET,
	publicId: 'p_abc',
	publishedAt: 1_700_000_000_000,
	ratingAverage: 4.5,
	ratingCount: 2,
	slug: 'economy',
	software: { name: 'PocketMine-MP', secretField: SECRET, slug: 'pocketmine' },
	summary: 'Short text',
	updatedAt: 1_700_000_000_000,
}
const pluginVersion = {
	changelog: 'Plugin notes',
	minecraftVersion: '1.26.60',
	normalizedVersion: '1.1.0',
	publishedAt: 1_700_000_000_000,
	release: {
		asset: { name: 'Economy.phar', sha256: 'abc123', size: 20 },
		build: {
			commitSha: SECRET,
			logsUrl: 'https://logs.example',
			workflowRunId: 7,
		},
		commitSha: 'deadbeef',
		githubReleaseUrl: 'https://github.example/release',
		verifiedBuild: true,
	},
	version: 'v1.1.0',
}
const plugin = {
	description: 'Long text',
	licenseCustom: undefined,
	links: { discord: 'https://discord.example', secretField: SECRET },
	project: pluginCard,
	repository: {
		defaultBranch: 'main',
		fullName: 'ann/economy',
		htmlUrl: 'https://github.example/ann/economy',
		secretField: SECRET,
	},
	versions: [
		pluginVersion,
		{
			normalizedVersion: '1.0.0',
			release: null,
			version: 'v1.0.0',
		},
	],
}
const server = {
	...privateFields,
	_id: 'srv1',
	averageRating: 4,
	categories: [{ _id: 'gm1', name: 'SMP', slug: 'smp' }],
	description: 'Long text',
	discordUrl: 'https://discord.example',
	ipAddress: 'Play.Example.Net',
	maxPlayers: 30,
	name: 'Server',
	online: true,
	owner: { image: 'a.png', type: 'user', username: 'ann' },
	playerCount: 2,
	port: 19_133,
	slug: 'server',
	smallDescription: 'Short text',
	software: { logoUrl: SECRET, name: 'PocketMine-MP', slug: 'pocketmine' },
	verifiedAt: 1_700_000_000_000,
}

const BROWSE_CONTENT = 'functions/projects/listing:browse'
const BROWSE_PLUGINS = 'functions/plugins/catalog:explore'
const BROWSE_SERVERS = 'functions/servers/listing:browse'
const CONTENT_CATEGORIES = 'functions/projects/categories:list'
const FEATURES = 'functions/site/settings:getFeatures'
const GET_CONTENT = 'functions/projects/projects:getPublishedBySlug'
const GET_PLUGIN = 'functions/plugins/catalog:getProject'
const GET_SERVER = 'functions/servers/servers:getPublishedBySlug'
const LATEST_RELEASE = 'functions/projects/versions:getLatest'
const LIST_RELEASES = 'functions/projects/versions:listPublic'
const PLUGIN_CATEGORIES = 'functions/plugins/categories:list'
const RELEASE_BY_VERSION = 'functions/projects/versions:getPublicByVersion'
const SERVER_CATEGORIES = 'functions/servers/categories:list'

const PLUGINS_ON = { [FEATURES]: { pluginsEnabled: true } }

interface Call {
	args: Record<string, unknown>
	path: string
}

function createRoutes(results: Record<string, unknown>) {
	const calls: Call[] = []
	const app = createCatalogRoutes({
		hubUrl: HUB_URL,
		query: async <Result>(path: string, args: Record<string, unknown> = {}) => {
			calls.push({ args, path })
			if (!(path in results)) {
				throw new Error(`Unexpected query ${path}`)
			}
			const result = results[path]
			if (result instanceof Error) {
				throw result
			}
			return result as Result
		},
	})
	return { app, calls }
}

async function getJson(
	app: ReturnType<typeof createCatalogRoutes>,
	url: string,
) {
	const response = await app.request(url)
	// biome-ignore lint/suspicious/noExplicitAny: assertions read each endpoint's own shape.
	return { body: (await response.json()) as any, response }
}

function page<Doc>(docs: Doc[], continueCursor = '', isDone = true) {
	return { continueCursor, isDone, page: docs }
}

describe.each([
	{
		doc: addon,
		other: resourcePack,
		path: '/addons',
		type: 'addon',
		url: `${HUB_URL}/addons/a_addon1`,
	},
	{
		doc: resourcePack,
		other: addon,
		path: '/resource-packs',
		type: 'resource_pack',
		url: `${HUB_URL}/resource-packs/rp_pack1`,
	},
])('catalog $path', ({ doc, other, path, type, url }) => {
	test('lists only its own type, with pagination', async () => {
		const { app, calls } = createRoutes({
			[BROWSE_CONTENT]: page([doc], 'next', false),
		})

		const { body, response } = await getJson(app, path)

		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
		expect(calls[0].args.type).toBe(type)
		expect(body.pagination).toEqual({ hasMore: true, nextCursor: 'next' })
		expect(body.data[0]).toMatchObject({
			gameVersions: ['1.26.60'],
			id: doc._id,
			latestVersion: '1.0.0',
			updatedAt: '2023-11-14T22:13:20.000Z',
			url,
		})
	})

	test('reports the end of the results', async () => {
		const { app } = createRoutes({ [BROWSE_CONTENT]: page([], 'x') })

		const { body } = await getJson(app, path)

		expect(body.pagination).toEqual({ hasMore: false, nextCursor: null })
	})

	test('returns its own items', async () => {
		const { app } = createRoutes({ [GET_CONTENT]: doc })

		const { body, response } = await getJson(app, `${path}/${doc.slug}`)

		expect(response.status).toBe(200)
		expect(body.data).toMatchObject({
			credits: [{ name: 'Ann', role: 'Art', url: null }],
			description: 'Long text',
			owner: { displayName: 'Org', slug: 'org', type: 'organization' },
		})
	})

	test.each(['', '/releases', '/releases/latest'])(
		'answers 404 for the other section\'s item at "%s"',
		async (suffix) => {
			const { app } = createRoutes({ [GET_CONTENT]: other })

			const { response } = await getJson(app, `${path}/${other.slug}${suffix}`)

			expect(response.status).toBe(404)
		},
	)

	test("answers 404 for the other section's release by version", async () => {
		const { app } = createRoutes({
			[RELEASE_BY_VERSION]: {
				...contentRelease,
				project: { type: other.type },
			},
		})

		const { response } = await getJson(
			app,
			`${path}/${other.slug}/releases/1.0.0`,
		)

		expect(response.status).toBe(404)
	})

	test.each([
		'/missing',
		'/missing/releases',
		'/missing/releases/latest',
		'/missing/releases/1.0.0',
	])('answers 404 for %s', async (suffix) => {
		const { app } = createRoutes({
			[GET_CONTENT]: null,
			[RELEASE_BY_VERSION]: null,
		})

		const { body, response } = await getJson(app, `${path}${suffix}`)

		expect(response.status).toBe(404)
		expect(body.error.code).toBe('NOT_FOUND')
	})

	test('lists releases with absolute Hub download URLs', async () => {
		const { app, calls } = createRoutes({
			[GET_CONTENT]: doc,
			[LIST_RELEASES]: [contentRelease],
		})

		const { body } = await getJson(app, `${path}/${doc.slug}/releases`)

		expect(calls[1].args).toEqual({ projectId: doc._id })
		expect(body.data).toEqual([
			{
				changelog: 'Notes',
				downloads: 3,
				downloadUrl: `${HUB_URL}/api/projects/versions/rel1/download`,
				fileName: 'dragons.mcaddon',
				fileSize: 10,
				gameVersions: ['1.26.60'],
				publishedAt: '2023-11-14T22:13:20.000Z',
				sha256: null,
				version: '1.0.0',
			},
		])
	})

	test('treats "latest" as the newest release, not a version string', async () => {
		const { app } = createRoutes({
			[GET_CONTENT]: doc,
			[LATEST_RELEASE]: contentRelease,
		})

		const { body } = await getJson(app, `${path}/${doc.slug}/releases/latest`)

		expect(body.data.version).toBe('1.0.0')
	})

	test('answers 404 when there is no public release', async () => {
		const { app } = createRoutes({
			[GET_CONTENT]: doc,
			[LATEST_RELEASE]: null,
		})

		const { response } = await getJson(
			app,
			`${path}/${doc.slug}/releases/latest`,
		)

		expect(response.status).toBe(404)
	})

	test('finds a release by version string', async () => {
		const { app, calls } = createRoutes({
			[RELEASE_BY_VERSION]: {
				...contentRelease,
				project: { type: doc.type },
			},
		})

		const { body } = await getJson(app, `${path}/${doc.slug}/releases/1.0.0`)

		expect(calls[0].args).toEqual({ slug: doc.slug, version: '1.0.0' })
		expect(body.data.version).toBe('1.0.0')
	})

	test.each([
		['?limit=0', 'limit'],
		['?limit=49', 'limit'],
		['?limit=abc', 'limit'],
		['?sort=random', 'sort'],
		[`?q=${'x'.repeat(101)}`, 'q'],
		[`?cursor=${'x'.repeat(4097)}`, 'cursor'],
		[`?gameVersion=${'x'.repeat(65)}`, 'gameVersion'],
	])('rejects %s', async (query, parameter) => {
		const { app, calls } = createRoutes({})

		const { body, response } = await getJson(app, `${path}${query}`)

		expect(response.status).toBe(400)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(body.error.code).toBe('INVALID_PARAMETER')
		expect(body.error.message).toStartWith(`${parameter}:`)
		expect(calls).toEqual([])
	})

	test('rejects an unknown category rather than widening the results', async () => {
		const { app, calls } = createRoutes({
			[CONTENT_CATEGORIES]: [addonCategory],
		})

		const { body, response } = await getJson(app, `${path}?category=nope`)

		expect(response.status).toBe(400)
		expect(body.error.message).toContain('nope')
		expect(calls.map((call) => call.path)).toEqual([CONTENT_CATEGORIES])
	})

	test('reports a cursor Hub refuses as a bad parameter', async () => {
		const { app } = createRoutes({
			[BROWSE_CONTENT]: new ConvexQueryError('Server Error'),
		})

		const { body, response } = await getJson(app, `${path}?cursor=garbage`)

		expect(response.status).toBe(400)
		expect(body.error.message).toStartWith('cursor:')
	})
})

describe('add-on and resource pack filters', () => {
	test('passes add-on filters to Hub, resolving category slugs to IDs', async () => {
		const { app, calls } = createRoutes({
			[BROWSE_CONTENT]: page([]),
			[CONTENT_CATEGORIES]: [addonCategory],
		})

		await getJson(
			app,
			'/addons?q=dragon&sort=rating&limit=5&cursor=abc&category=mobs&gameVersion=1.26.60&gameVersion=1.26.50&resolution=16x',
		)

		expect(calls[0]).toEqual({
			args: { projectType: 'addon' },
			path: CONTENT_CATEGORIES,
		})
		expect(calls[1].args).toEqual({
			categoryIds: ['cat1'],
			gameVersions: ['1.26.60', '1.26.50'],
			paginationOpts: { cursor: 'abc', numItems: 5 },
			query: 'dragon',
			sort: 'rating',
			type: 'addon',
		})
	})

	test('filters resource packs by resolution', async () => {
		const { app, calls } = createRoutes({ [BROWSE_CONTENT]: page([]) })

		await getJson(app, '/resource-packs?resolution=16x&resolution=32x')

		expect(calls[0].args.resourcePackResolutions).toEqual(['16x', '32x'])
	})

	test('rejects an unknown resolution', async () => {
		const { app } = createRoutes({})

		const { response } = await getJson(app, '/resource-packs?resolution=1000x')

		expect(response.status).toBe(400)
	})

	test('describes add-ons and resource packs by what they contain', async () => {
		const { app } = createRoutes({ [GET_CONTENT]: addon })
		const { app: packApp } = createRoutes({ [GET_CONTENT]: resourcePack })

		expect((await getJson(app, '/addons/dragons')).body.data.metadata).toEqual({
			behaviorPackIncluded: true,
			dependencies: [{ name: 'Lib', url: null }],
			experimentalFeaturesRequired: false,
			resourcePackIncluded: false,
		})
		expect(
			(await getJson(packApp, '/resource-packs/pack')).body.data.metadata,
		).toEqual({ contentTypes: ['textures'], resolution: '16x' })
	})
})

describe('catalog /plugins', () => {
	test('lists plugins by their stable public ID', async () => {
		const { app, calls } = createRoutes({
			...PLUGINS_ON,
			[BROWSE_PLUGINS]: page([pluginCard], 'next', false),
		})

		const { body } = await getJson(app, '/plugins')

		expect(calls[1].args).toEqual({
			paginationOpts: { cursor: null, numItems: 24 },
			sort: 'latest',
		})
		expect(body.pagination).toEqual({ hasMore: true, nextCursor: 'next' })
		expect(body.data[0]).toEqual({
			categories: [{ name: 'Economy', slug: 'economy' }],
			iconUrl: 'icon.png',
			id: 'p_abc',
			latestVersion: 'v1.1.0',
			latestVersionAt: '2023-11-14T22:13:20.000Z',
			license: 'MIT',
			name: 'Economy',
			owner: {
				displayName: 'Ann',
				imageUrl: 'a.png',
				slug: 'ann',
				type: 'user',
			},
			publishedAt: '2023-11-14T22:13:20.000Z',
			slug: 'economy',
			software: { name: 'PocketMine-MP', slug: 'pocketmine' },
			stats: { averageRating: 4.5, reviews: 2 },
			summary: 'Short text',
			updatedAt: '2023-11-14T22:13:20.000Z',
			url: `${HUB_URL}/plugins/p_abc`,
		})
	})

	test('passes filters to Hub', async () => {
		const { app, calls } = createRoutes({
			...PLUGINS_ON,
			[BROWSE_PLUGINS]: page([]),
			[PLUGIN_CATEGORIES]: [{ _id: 'c', name: 'Economy', slug: 'economy' }],
		})

		await getJson(
			app,
			'/plugins?q=money&sort=rating&limit=5&category=economy&software=pocketmine&software=nukkit',
		)

		expect(calls.at(-1)?.args).toEqual({
			categorySlugs: ['economy'],
			paginationOpts: { cursor: null, numItems: 5 },
			search: 'money',
			softwareSlugs: ['pocketmine', 'nukkit'],
			sort: 'rating',
		})
	})

	test('rejects an unknown category and sort', async () => {
		const { app } = createRoutes({ ...PLUGINS_ON, [PLUGIN_CATEGORIES]: [] })

		expect((await getJson(app, '/plugins?category=x')).response.status).toBe(
			400,
		)
		expect(
			(await getJson(app, '/plugins?sort=downloads')).response.status,
		).toBe(400)
	})

	test('returns plugin detail with its repository', async () => {
		const { app } = createRoutes({ ...PLUGINS_ON, [GET_PLUGIN]: plugin })

		const { body } = await getJson(app, '/plugins/p_abc')

		expect(body.data).toMatchObject({
			description: 'Long text',
			id: 'p_abc',
			links: { discord: 'https://discord.example', website: null },
			repository: {
				defaultBranch: 'main',
				fullName: 'ann/economy',
				url: 'https://github.example/ann/economy',
			},
		})
	})

	test('lists releases with checksums and build details', async () => {
		const { app } = createRoutes({ ...PLUGINS_ON, [GET_PLUGIN]: plugin })

		const { body } = await getJson(app, '/plugins/economy/releases')

		expect(body.data[0]).toEqual({
			buildLogsUrl: 'https://logs.example',
			changelog: 'Plugin notes',
			commitSha: 'deadbeef',
			downloadUrl: `${HUB_URL}/plugins/p_abc/download/1.1.0`,
			fileName: 'Economy.phar',
			fileSize: 20,
			gameVersions: ['1.26.60'],
			githubReleaseUrl: 'https://github.example/release',
			publishedAt: '2023-11-14T22:13:20.000Z',
			sha256: 'abc123',
			verifiedBuild: true,
			version: 'v1.1.0',
		})
	})

	test('reports a version with no published file as not downloadable', async () => {
		const { app } = createRoutes({ ...PLUGINS_ON, [GET_PLUGIN]: plugin })

		const { body } = await getJson(app, '/plugins/economy/releases/v1.0.0')

		expect(body.data).toMatchObject({
			downloadUrl: null,
			fileName: null,
			sha256: null,
			verifiedBuild: false,
			version: 'v1.0.0',
		})
	})

	test('finds the latest release and any by display or normalized version', async () => {
		const { app } = createRoutes({ ...PLUGINS_ON, [GET_PLUGIN]: plugin })

		for (const version of ['latest', 'v1.1.0', '1.1.0']) {
			const { body } = await getJson(
				app,
				`/plugins/economy/releases/${version}`,
			)
			expect(body.data.version).toBe('v1.1.0')
		}
	})

	test('answers 404 for a missing plugin, release or latest release', async () => {
		const missing = createRoutes({ ...PLUGINS_ON, [GET_PLUGIN]: null })
		const noReleases = createRoutes({
			...PLUGINS_ON,
			[GET_PLUGIN]: {
				...plugin,
				project: { ...pluginCard, latestVersion: null },
				versions: [],
			},
		})

		expect((await getJson(missing.app, '/plugins/x')).response.status).toBe(404)
		expect(
			(await getJson(noReleases.app, '/plugins/x/releases/latest')).response
				.status,
		).toBe(404)
		expect(
			(await getJson(noReleases.app, '/plugins/x/releases/9.9.9')).response
				.status,
		).toBe(404)
	})

	test.each([{ pluginsEnabled: false }, {}])(
		'hides everything when the registry is off: %j',
		async (features) => {
			const { app, calls } = createRoutes({ [FEATURES]: features })

			for (const url of [
				'/plugins',
				'/plugins/economy',
				'/plugins/economy/releases',
				'/plugins/economy/releases/latest',
				'/plugin-categories',
			]) {
				const { body, response } = await getJson(app, url)
				expect(response.status).toBe(404)
				expect(body.error.code).toBe('NOT_FOUND')
			}
			expect(calls.every((call) => call.path === FEATURES)).toBe(true)
		},
	)
})

describe('catalog /servers', () => {
	test('lists servers with live status and a short cache', async () => {
		const { app } = createRoutes({ [BROWSE_SERVERS]: page([server]) })

		const { body, response } = await getJson(app, '/servers')

		expect(response.headers.get('Cache-Control')).toBe('public, max-age=30')
		expect(body.data[0]).toMatchObject({
			address: { host: 'Play.Example.Net', port: 19_133 },
			status: { maxPlayers: 30, online: true, players: 2 },
			summary: 'Short text',
			url: `${HUB_URL}/server/play.example.net:19133`,
			verified: true,
		})
	})

	test('leaves the default port out of server links', async () => {
		const { app } = createRoutes({
			[GET_SERVER]: { ...server, port: 19_132 },
		})

		const { body } = await getJson(app, '/servers/server')

		expect(body.data.url).toBe(`${HUB_URL}/server/play.example.net`)
	})

	test('reports null status for a server not checked yet', async () => {
		const { app } = createRoutes({
			[GET_SERVER]: {
				...server,
				maxPlayers: undefined,
				online: undefined,
				playerCount: undefined,
				verifiedAt: undefined,
			},
		})

		const { body } = await getJson(app, '/servers/server')

		expect(body.data.status).toEqual({
			maxPlayers: null,
			online: null,
			players: 0,
		})
		expect(body.data.verified).toBe(false)
	})

	test('passes filters to Hub', async () => {
		const { app, calls } = createRoutes({
			[BROWSE_SERVERS]: page([]),
			[SERVER_CATEGORIES]: [{ _id: 'gm1', name: 'SMP', slug: 'smp' }],
		})

		await getJson(
			app,
			'/servers?q=sky&status=online&sort=trending&category=smp&region=EU&software=pocketmine&gameVersion=1.26.60',
		)

		expect(calls[1].args).toEqual({
			categories: ['smp'],
			gameVersions: ['1.26.60'],
			paginationOpts: { cursor: null, numItems: 24 },
			query: 'sky',
			regions: ['EU'],
			software: 'pocketmine',
			sort: 'trending',
			status: ['online'],
		})
	})

	test('rejects an unknown gamemode rather than widening the results', async () => {
		const { app } = createRoutes({ [SERVER_CATEGORIES]: [] })

		const { response } = await getJson(app, '/servers?category=nope')

		expect(response.status).toBe(400)
	})

	test('returns server detail', async () => {
		const { app } = createRoutes({ [GET_SERVER]: server })

		const { body } = await getJson(app, '/servers/server')

		expect(body.data).toMatchObject({
			description: 'Long text',
			links: { discord: 'https://discord.example' },
			owner: { displayName: 'ann', imageUrl: 'a.png', type: 'user' },
			software: { name: 'PocketMine-MP', slug: 'pocketmine' },
		})
	})

	test('answers 404 for a server that is not public', async () => {
		const { app } = createRoutes({ [GET_SERVER]: null })

		const { response } = await getJson(app, '/servers/hidden')

		expect(response.status).toBe(404)
	})
})

describe('catalog filter values', () => {
	test.each([
		['/addon-categories', { projectType: 'addon' }],
		['/resource-pack-categories', { projectType: 'resource_pack' }],
	])('%s asks Hub for its own type', async (url, args) => {
		const { app, calls } = createRoutes({
			[CONTENT_CATEGORIES]: [addonCategory],
		})

		const { body } = await getJson(app, url)

		expect(calls[0].args).toEqual(args)
		expect(body.data).toEqual([
			{ description: 'Creatures', name: 'Mobs', slug: 'mobs' },
		])
	})

	test('serves plugin and server categories, software and game versions', async () => {
		const { app } = createRoutes({
			...PLUGINS_ON,
			[PLUGIN_CATEGORIES]: [{ _id: 'c', name: 'Economy', slug: 'economy' }],
			[SERVER_CATEGORIES]: [{ _id: 'gm1', name: 'SMP', slug: 'smp' }],
			'functions/servers/software:listEnabled': [
				{ ...privateFields, description: 'Text', name: 'PMMP', slug: 'pmmp' },
			],
			'functions/site/gameVersions:listActive': [
				{ createdAt: 1, isActive: true, version: '1.26.60' },
			],
		})

		expect((await getJson(app, '/plugin-categories')).body.data).toEqual([
			{ description: null, name: 'Economy', slug: 'economy' },
		])
		expect((await getJson(app, '/server-categories')).body.data).toEqual([
			{ description: null, name: 'SMP', slug: 'smp' },
		])
		expect((await getJson(app, '/server-software')).body.data).toEqual([
			{
				description: 'Text',
				logoUrl: null,
				name: 'PMMP',
				repositoryUrl: null,
				slug: 'pmmp',
				websiteUrl: null,
			},
		])
		expect((await getJson(app, '/game-versions')).body.data).toEqual([
			'1.26.60',
		])
	})

	test.each([
		'/projects',
		'/projects/pack',
		'/project-types',
		'/project-categories',
	])('no longer serves %s', async (url) => {
		const { app } = createRoutes({})

		const { response } = await getJson(app, url)

		expect(response.status).toBe(404)
	})
})

describe('catalog privacy', () => {
	test('never returns a private field from any endpoint', async () => {
		const { app } = createRoutes({
			...PLUGINS_ON,
			[BROWSE_CONTENT]: page([addon]),
			[BROWSE_PLUGINS]: page([pluginCard]),
			[BROWSE_SERVERS]: page([server]),
			[CONTENT_CATEGORIES]: [addonCategory],
			[GET_PLUGIN]: plugin,
			[GET_SERVER]: server,
			[LATEST_RELEASE]: contentRelease,
			[LIST_RELEASES]: [contentRelease],
			[PLUGIN_CATEGORIES]: [
				{ ...privateFields, _id: 'p', name: 'p', slug: 'p' },
			],
			[RELEASE_BY_VERSION]: {
				...contentRelease,
				project: { type: 'addon' },
			},
			[SERVER_CATEGORIES]: [
				{ ...privateFields, _id: 'g', name: 'g', slug: 'g' },
			],
			'functions/servers/software:listEnabled': [
				{ ...privateFields, name: 'n', slug: 's' },
			],
			'functions/site/gameVersions:listActive': [
				{ ...privateFields, version: '1' },
			],
			[GET_CONTENT]: addon,
		})

		const urls = [
			'/addons',
			'/addons/dragons',
			'/addons/dragons/releases',
			'/addons/dragons/releases/latest',
			'/addons/dragons/releases/1.0.0',
			'/addon-categories',
			'/resource-pack-categories',
			'/plugins',
			'/plugins/economy',
			'/plugins/economy/releases',
			'/plugins/economy/releases/latest',
			'/plugin-categories',
			'/servers',
			'/servers/server',
			'/server-categories',
			'/server-software',
			'/game-versions',
		]
		for (const url of urls) {
			const response = await app.request(url)
			expect(response.status).toBe(200)
			expect(await response.text()).not.toContain(SECRET)
		}
	})

	test('leaves resource pack documents just as private', async () => {
		const { app } = createRoutes({
			[BROWSE_CONTENT]: page([resourcePack]),
			[GET_CONTENT]: resourcePack,
		})

		for (const url of ['/resource-packs', '/resource-packs/pack']) {
			const response = await app.request(url)
			expect(response.status).toBe(200)
			expect(await response.text()).not.toContain(SECRET)
		}
	})
})

describe('catalog failures', () => {
	test('answers 503 when no Convex deployment is configured', async () => {
		const app = createCatalogRoutes({ hubUrl: HUB_URL })

		const { body, response } = await getJson(app, '/game-versions')

		expect(response.status).toBe(503)
		expect(body.error.code).toBe('CATALOG_UNAVAILABLE')
	})

	test.each([
		['unreachable', new ConvexUnavailableError('down')],
		['failing', new ConvexQueryError('Server Error')],
	])('answers 503 without detail when Hub is %s', async (_label, error) => {
		const { app } = createRoutes({ [BROWSE_CONTENT]: error })

		const { body, response } = await getJson(app, '/addons')

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(JSON.stringify(body)).not.toContain('Server Error')
	})

	test('hides unexpected errors', async () => {
		const { app } = createRoutes({
			[BROWSE_CONTENT]: new Error('internal detail'),
		})

		const { body, response } = await getJson(app, '/addons')

		expect(response.status).toBe(500)
		expect(JSON.stringify(body)).not.toContain('internal detail')
	})

	test('answers unknown endpoints in the catalog error format', async () => {
		const { app } = createRoutes({})

		const { body, response } = await getJson(app, '/nope')

		expect(response.status).toBe(404)
		expect(body.error.code).toBe('NOT_FOUND')
	})

	test('does not accept writes', async () => {
		const { app } = createRoutes({})

		const response = await app.request('/addons', { method: 'POST' })

		expect(response.status).toBe(404)
	})
})

describe('catalog contract', () => {
	test('documents every route and nothing else', () => {
		const { app } = createRoutes({})
		const routes = new Set(
			app.routes
				.filter((route) => route.method === 'GET')
				.map((route) => `/v1${route.path}`.replaceAll(/:(\w+)/g, '{$1}'))
				// `latest` is a documented value of `{version}`.
				.filter((path) => !path.endsWith('/releases/latest')),
		)

		expect([...routes].sort()).toEqual(
			Object.keys(catalogOpenApiDocument.paths).sort(),
		)
	})

	test('serves the OpenAPI document', async () => {
		const { app } = createRoutes({})

		const { body } = await getJson(app, '/openapi.json')

		expect(body.openapi).toBe('3.1.0')
	})

	test('resolves every schema reference in the document', () => {
		const document = JSON.stringify(catalogOpenApiDocument)
		const references = document.matchAll(
			/#\/components\/(schemas|responses)\/(\w+)/g,
		)
		const components = catalogOpenApiDocument.components as unknown as Record<
			string,
			Record<string, unknown>
		>

		for (const [, kind, name] of references) {
			expect(components[kind][name]).toBeDefined()
		}
	})
})

describe('catalog through the full app', () => {
	let fakeConvex: ReturnType<typeof Bun.serve>
	const received: unknown[] = []

	beforeAll(() => {
		fakeConvex = Bun.serve({
			fetch: async (request) => {
				received.push({
					body: await request.json(),
					path: new URL(request.url).pathname,
				})
				return Response.json({
					status: 'success',
					value: [{ version: '1.26.60' }],
				})
			},
			hostname: '127.0.0.1',
			port: 0,
		})
	})

	afterAll(() => {
		fakeConvex.stop(true)
	})

	function createTestApp(overrides: Partial<AppConfig> = {}) {
		return createApp({
			apiKey: 'test-secret',
			artifactAllowedHosts: [],
			catalogRateLimit: 2,
			convexUrl: `http://127.0.0.1:${fakeConvex.port}/`,
			corsOrigins: ['https://bedrocknexus.test'],
			generalRateLimit: 1,
			hubUrl: HUB_URL,
			maxConcurrentStatusChecks: 2,
			maxQueuedStatusChecks: 2,
			statusRateLimit: 2,
			trustProxyHeaders: false,
			...overrides,
		})
	}

	test('calls the Convex query API', async () => {
		const response = await createTestApp().request('/v1/game-versions')

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ data: ['1.26.60'] })
		expect(received.at(-1)).toEqual({
			body: {
				args: {},
				format: 'json',
				path: 'functions/site/gameVersions:listActive',
			},
			path: '/api/query',
		})
	})

	test('answers 503 when Convex cannot be reached', async () => {
		const response = await createTestApp({
			convexUrl: 'http://127.0.0.1:1',
		}).request('/v1/game-versions')

		expect(response.status).toBe(503)
	})

	test('lets any site read the catalog but not other routes', async () => {
		const app = createTestApp()
		const headers = { Origin: 'https://community.example' }

		const catalog = await app.request('/v1/openapi.json', { headers })
		const health = await app.request('/health', { headers })
		const preflight = await app.request('/v1/openapi.json', {
			headers: { ...headers, 'Access-Control-Request-Method': 'GET' },
			method: 'OPTIONS',
		})

		expect(catalog.headers.get('Access-Control-Allow-Origin')).toBe('*')
		expect(health.headers.get('Access-Control-Allow-Origin')).toBeNull()
		expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*')
	})

	test('applies its own rate limit, separate from the general one', async () => {
		const app = createTestApp()

		const first = await app.request('/v1/openapi.json')
		const second = await app.request('/v1/openapi.json')
		const limited = await app.request('/v1/openapi.json')

		expect(first.status).toBe(200)
		expect(second.status).toBe(200)
		expect(limited.status).toBe(429)
		expect((await limited.json()) as unknown).toEqual({
			error: {
				code: 'RATE_LIMITED',
				message: 'Too many catalog requests, please try again later',
			},
		})
	})

	test('does not expose the internal key boundary to catalog callers', async () => {
		const response = await createTestApp().request('/server-verify/check', {
			method: 'POST',
		})

		expect(response.status).toBe(401)
	})
})
