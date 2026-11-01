type Schema = Record<string, unknown>

const string: Schema = { type: 'string' }
const nullableString: Schema = { type: ['string', 'null'] }
const nullableInteger: Schema = { type: ['integer', 'null'] }
const integer: Schema = { type: 'integer' }
const number: Schema = { type: 'number' }
const timestamp: Schema = { format: 'date-time', type: ['string', 'null'] }
const stringList: Schema = { items: string, type: 'array' }

const CONTENT_SORTS = [
	'downloads',
	'trending',
	'updated',
	'newest',
	'rating',
	'saved',
]
const UPDATE_SECTIONS = ['addons', 'resource-packs', 'plugins']
const RESOLUTIONS = [
	'8x',
	'16x',
	'32x',
	'64x',
	'128x',
	'256x',
	'512x',
	'custom',
]

function ref(name: string): Schema {
	return { $ref: `#/components/schemas/${name}` }
}

function object(properties: Record<string, Schema>): Schema {
	return { properties, required: Object.keys(properties), type: 'object' }
}

function nullableRef(name: string): Schema {
	return { oneOf: [{ type: 'null' }, ref(name)] }
}

function arrayOf(schema: Schema): Schema {
	return { items: schema, type: 'array' }
}

function dataOf(schema: Schema): Schema {
	return object({ data: schema })
}

function listOf(schema: Schema): Schema {
	return dataOf(arrayOf(schema))
}

function pageOf(schema: Schema): Schema {
	return object({ data: arrayOf(schema), pagination: ref('Pagination') })
}

function parameter(
	name: string,
	description: string,
	schema: Schema = string,
): Schema {
	return { description, in: 'query', name, schema }
}

function repeatable(name: string, description: string, values?: string[]) {
	return parameter(name, `${description} Repeat to match any of several.`, {
		items: values ? { enum: values, type: 'string' } : string,
		type: 'array',
	})
}

function enumeration(name: string, description: string, values: string[]) {
	return parameter(name, description, { enum: values, type: 'string' })
}

function reference(description: string): Schema {
	return {
		description,
		in: 'path',
		name: 'reference',
		required: true,
		schema: string,
	}
}

const contentReference = reference('The `id` (preferred) or current `slug`.')
const versionPath: Schema = {
	description: 'A version string, or `latest` for the newest release.',
	in: 'path',
	name: 'version',
	required: true,
	schema: string,
}

const searchParameter = parameter(
	'q',
	'Search text. Results come by relevance and `sort` is ignored.',
)
const listParameters = [
	parameter('limit', 'Page size, 1 to 48. Defaults to 24.', integer),
	parameter(
		'cursor',
		'`pagination.nextCursor` from the previous page. Cursors are opaque.',
	),
	searchParameter,
]

function get(
	summary: string,
	body: Schema,
	parameters: Schema[] = [],
	errors: string[] = ['429', '503'],
) {
	return {
		get: {
			parameters,
			responses: {
				'200': {
					content: { 'application/json': { schema: body } },
					description: 'Success',
				},
				...Object.fromEntries(
					errors.map((status) => [
						status,
						{ $ref: `#/components/responses/${status}` },
					]),
				),
			},
			summary,
		},
	}
}

function downloadRoute() {
	return {
		get: {
			summary: 'Issue a fresh download redirect',
			description:
				'Rechecks public availability and counts at most once per requester per release per day. A redirect is not proof of completed transfer. Responses are never cached. HEAD is rejected without counting.',
			parameters: [contentReference, versionPath],
			responses: {
				'307': {
					description: 'Temporary redirect to the release file',
					headers: {
						Location: { schema: string },
						'Cache-Control': { schema: string },
					},
				},
				...Object.fromEntries(
					['404', '409', '410', '429', '503'].map((status) => [
						status,
						{
							description:
								status === '429'
									? 'Rate limited; see Retry-After'
									: 'Download unavailable',
							content: { 'application/json': { schema: ref('Error') } },
						},
					]),
				),
			},
		},
	}
}

const LIST_ERRORS = ['400', '429', '503']
const ITEM_ERRORS = ['404', '429', '503']

/** The endpoints add-ons and resource packs have in common. */
function contentPaths(
	path: string,
	name: string,
	plural: string,
	summary: string,
	detail: string,
	extraParameters: Schema[] = [],
) {
	return {
		[path]: get(
			`Search and browse published ${plural}`,
			pageOf(ref(summary)),
			[
				...listParameters,
				enumeration('sort', 'Defaults to downloads.', CONTENT_SORTS),
				repeatable('category', 'Category slug.'),
				repeatable('gameVersion', 'Supported Minecraft version.'),
				...extraParameters,
			],
			LIST_ERRORS,
		),
		[`${path}/{reference}`]: get(
			`A published ${name}`,
			dataOf(ref(detail)),
			[contentReference],
			ITEM_ERRORS,
		),
		[`${path}/{reference}/releases/{version}/download`]: downloadRoute(),
		[`${path}/{reference}/releases`]: get(
			`A ${name}'s public releases, newest first`,
			listOf(ref('ContentRelease')),
			[contentReference],
			ITEM_ERRORS,
		),
		[`${path}/{reference}/releases/{version}`]: get(
			`One public release of a ${name}`,
			dataOf(ref('ContentRelease')),
			[contentReference, versionPath],
			ITEM_ERRORS,
		),
	}
}

const links = {
	discord: nullableString,
	donation: nullableString,
	issues: nullableString,
	website: nullableString,
	wiki: nullableString,
}

const contentSummaryProperties = {
	bannerUrl: nullableString,
	categories: arrayOf(ref('CategorySummary')),
	gameVersions: stringList,
	iconUrl: nullableString,
	id: string,
	latestVersion: nullableString,
	latestVersionAt: timestamp,
	name: string,
	publishedAt: timestamp,
	slug: string,
	stats: object({
		averageRating: number,
		downloads: integer,
		favourites: integer,
		reviews: integer,
	}),
	summary: string,
	tags: stringList,
	updatedAt: timestamp,
	url: { description: 'Page on BedrockNexus.', type: 'string' },
}

const contentDetailProperties = {
	credits: arrayOf(object({ name: string, role: string, url: nullableString })),
	description: { description: 'Markdown.', type: 'string' },
	license: nullableString,
	licenseCustom: nullableString,
	links: object({ ...links, source: nullableString }),
	owner: nullableRef('Owner'),
}

const addonMetadata: Schema = {
	oneOf: [
		{ type: 'null' },
		object({
			behaviorPackIncluded: { type: 'boolean' },
			dependencies: arrayOf(object({ name: string, url: nullableString })),
			experimentalFeaturesRequired: { type: 'boolean' },
			resourcePackIncluded: { type: 'boolean' },
		}),
	],
}

const resourcePackMetadata: Schema = {
	oneOf: [
		{ type: 'null' },
		object({
			contentTypes: stringList,
			resolution: { enum: RESOLUTIONS, type: 'string' },
		}),
	],
}

const pluginSummaryProperties = {
	categories: arrayOf(ref('CategorySummary')),
	iconUrl: nullableString,
	id: {
		description: 'Stable public ID, such as `p_j465gg`.',
		type: 'string',
	},
	latestVersion: nullableString,
	latestVersionAt: timestamp,
	license: nullableString,
	name: string,
	owner: nullableRef('Owner'),
	publishedAt: timestamp,
	slug: string,
	software: object({ name: string, slug: string }),
	stats: object({ averageRating: number, reviews: integer }),
	summary: string,
	updatedAt: timestamp,
	url: { description: 'Page on BedrockNexus.', type: 'string' },
}

const releaseProperties = {
	changelog: { description: 'Markdown.', type: 'string' },
	downloadUrl: {
		description:
			'BedrockNexus download route, which redirects to the file. Null if the release has no file. Do not store the redirect target.',
		type: ['string', 'null'],
	},
	fileName: nullableString,
	fileSize: nullableInteger,
	gameVersions: stringList,
	publishedAt: timestamp,
	sha256: {
		description:
			'SHA-256 of the file. Verify downloads against it. Null only for add-ons and resource packs released before checksums were recorded.',
		type: ['string', 'null'],
	},
	version: string,
}

const serverSummaryProperties = {
	address: object({ host: string, port: integer }),
	bannerUrl: nullableString,
	categories: arrayOf(ref('CategorySummary')),
	gameVersions: stringList,
	id: string,
	languages: stringList,
	listed: {
		description:
			'False once the server has been offline for 14 days. It is then left out of `/v1/servers`, and returns on its next successful check.',
		type: 'boolean',
	},
	logoUrl: nullableString,
	name: string,
	publishedAt: timestamp,
	region: nullableString,
	slug: string,
	stats: object({
		averageRating: number,
		favourites: integer,
		reviews: integer,
	}),
	status: object({
		maxPlayers: nullableInteger,
		online: {
			description: 'Null until the server has been checked.',
			type: ['boolean', 'null'],
		},
		players: integer,
	}),
	summary: string,
	tags: stringList,
	updatedAt: timestamp,
	url: { description: 'Page on BedrockNexus.', type: 'string' },
	verified: { type: 'boolean' },
}

function errorResponse(description: string) {
	return {
		content: { 'application/json': { schema: ref('Error') } },
		description,
	}
}

export const catalogOpenApiDocument = {
	components: {
		responses: {
			'400': errorResponse('A query parameter is invalid.'),
			'404': errorResponse('The resource does not exist or is not public.'),
			'429': errorResponse('Rate limit exceeded.'),
			'503': errorResponse('The catalog is temporarily unavailable.'),
		},
		schemas: {
			AddonDetail: object({
				...contentSummaryProperties,
				...contentDetailProperties,
				metadata: addonMetadata,
			}),
			AddonSummary: object({
				...contentSummaryProperties,
				metadata: addonMetadata,
			}),
			GameVersion: object({
				name: {
					description:
						'As shown on the site, and what `gameVersion` filters match.',
					type: 'string',
				},
				version: {
					description: 'The Minecraft version alone, such as `1.26.60`.',
					type: 'string',
				},
			}),
			Update: object({
				found: {
					description:
						'False if the item does not exist, is not public, or is in another section.',
					type: 'boolean',
				},
				id: string,
				installedVersion: nullableString,
				latestVersion: nullableString,
				release: {
					description: 'The newest public release, if any.',
					oneOf: [{ type: 'null' }, object(releaseProperties)],
				},
				section: { enum: UPDATE_SECTIONS, type: 'string' },
				slug: nullableString,
				updateAvailable: {
					description:
						'True if a version was sent and the newest release has a different one.',
					type: 'boolean',
				},
			}),
			Category: object({
				description: nullableString,
				name: string,
				slug: string,
			}),
			CategorySummary: object({ name: string, slug: string }),
			ContentRelease: object({ ...releaseProperties, downloads: integer }),
			Error: object({
				error: object({
					code: {
						description:
							'INVALID_PARAMETER, NOT_FOUND, RATE_LIMITED, CATALOG_UNAVAILABLE or INTERNAL_ERROR.',
						type: 'string',
					},
					message: string,
				}),
			}),
			Owner: object({
				displayName: nullableString,
				imageUrl: nullableString,
				slug: nullableString,
				type: { enum: ['user', 'organization'], type: 'string' },
			}),
			Pagination: object({
				hasMore: {
					description:
						'Keep requesting while true. A page can be short, or empty, while more results remain.',
					type: 'boolean',
				},
				nextCursor: nullableString,
			}),
			PluginDetail: object({
				...pluginSummaryProperties,
				description: { description: 'Markdown.', type: 'string' },
				licenseCustom: nullableString,
				links: object(links),
				repository: object({
					defaultBranch: string,
					fullName: string,
					url: string,
				}),
			}),
			PluginRelease: object({
				...releaseProperties,
				buildLogsUrl: nullableString,
				commitSha: nullableString,
				githubReleaseUrl: nullableString,
				verifiedBuild: {
					description: 'Built by the unmodified managed workflow.',
					type: 'boolean',
				},
			}),
			PluginSummary: object(pluginSummaryProperties),
			ResourcePackDetail: object({
				...contentSummaryProperties,
				...contentDetailProperties,
				metadata: resourcePackMetadata,
			}),
			ResourcePackSummary: object({
				...contentSummaryProperties,
				metadata: resourcePackMetadata,
			}),
			ServerDetail: object({
				...serverSummaryProperties,
				description: { description: 'Markdown.', type: 'string' },
				links: object({
					discord: nullableString,
					store: nullableString,
					website: nullableString,
					wiki: nullableString,
				}),
				owner: nullableRef('Owner'),
				software: {
					description: 'Declared by the server owner.',
					oneOf: [{ type: 'null' }, object({ name: string, slug: string })],
				},
			}),
			ServerSoftware: object({
				description: string,
				logoUrl: nullableString,
				name: string,
				repositoryUrl: nullableString,
				slug: string,
				websiteUrl: nullableString,
			}),
			ServerSummary: object(serverSummaryProperties),
		},
	},
	info: {
		description:
			'Read-only public data for launchers, bots and community sites. Timestamps are ISO 8601 in UTC, and missing optional values are null.',
		title: 'BedrockNexus Catalog API',
		version: '1.0.0',
	},
	openapi: '3.1.0',
	paths: {
		...contentPaths(
			'/v1/addons',
			'add-on',
			'add-ons',
			'AddonSummary',
			'AddonDetail',
		),
		...contentPaths(
			'/v1/resource-packs',
			'resource pack',
			'resource packs',
			'ResourcePackSummary',
			'ResourcePackDetail',
			[repeatable('resolution', 'Pack resolution.', RESOLUTIONS)],
		),
		'/v1/addon-categories': get('Add-on categories', listOf(ref('Category'))),
		'/v1/game-versions': get(
			'Minecraft versions shown in version pickers',
			listOf(ref('GameVersion')),
		),
		'/v1/openapi.json': get('This document', { type: 'object' }, [], ['429']),
		'/v1/plugin-categories': get(
			'Plugin categories',
			listOf(ref('Category')),
			[],
			ITEM_ERRORS,
		),
		'/v1/plugins': get(
			'Search and browse published plugins',
			pageOf(ref('PluginSummary')),
			[
				...listParameters,
				enumeration('sort', 'Defaults to latest.', ['latest', 'rating']),
				repeatable(
					'category',
					'Category slug. Results filtered this way, or by several software, are not paginated and stop at `limit`.',
				),
				repeatable('software', 'Server software slug.'),
			],
			['400', '404', '429', '503'],
		),
		'/v1/plugins/{reference}': get(
			'A published plugin',
			dataOf(ref('PluginDetail')),
			[contentReference],
			ITEM_ERRORS,
		),
		'/v1/plugins/{reference}/releases/{version}/download': downloadRoute(),
		'/v1/plugins/{reference}/releases': get(
			"A plugin's published releases, newest first (at most 50)",
			listOf(ref('PluginRelease')),
			[contentReference],
			ITEM_ERRORS,
		),
		'/v1/plugins/{reference}/releases/{version}': get(
			'One published release of a plugin',
			dataOf(ref('PluginRelease')),
			[contentReference, versionPath],
			ITEM_ERRORS,
		),
		'/v1/resource-pack-categories': get(
			'Resource pack categories',
			listOf(ref('Category')),
		),
		'/v1/server-categories': get('Server gamemodes', listOf(ref('Category'))),
		'/v1/server-software': get(
			'Server software owners can declare',
			listOf(ref('ServerSoftware')),
		),
		'/v1/servers': get(
			'Search and browse published servers',
			pageOf(ref('ServerSummary')),
			[
				...listParameters,
				enumeration('sort', 'Defaults to players.', [
					'players',
					'trending',
					'rating',
					'newest',
					'saved',
				]),
				enumeration('status', 'Only servers with this live status.', [
					'online',
					'offline',
				]),
				parameter('software', 'Server software slug.'),
				repeatable('category', 'Gamemode slug.'),
				repeatable('gameVersion', 'Minecraft version the owner lists.'),
				repeatable('region', 'Region.'),
			],
			LIST_ERRORS,
		),
		'/v1/updates': {
			post: {
				requestBody: {
					content: {
						'application/json': {
							schema: object({
								items: {
									items: {
										properties: {
											id: {
												description: 'The `id` (preferred) or current `slug`.',
												type: 'string',
											},
											section: { enum: UPDATE_SECTIONS, type: 'string' },
											version: {
												description: 'The installed version, if any.',
												type: 'string',
											},
										},
										required: ['id', 'section'],
										type: 'object',
									},
									maxItems: 100,
									minItems: 1,
									type: 'array',
								},
							}),
						},
					},
					required: true,
				},
				responses: {
					'200': {
						content: { 'application/json': { schema: listOf(ref('Update')) } },
						description: 'One result per item, in request order.',
					},
					'400': { $ref: '#/components/responses/400' },
					'429': { $ref: '#/components/responses/429' },
					'503': { $ref: '#/components/responses/503' },
				},
				summary: 'The newest release of up to 100 installed items',
			},
		},
		'/v1/servers/{reference}': get(
			'A published server, with its latest status',
			dataOf(ref('ServerDetail')),
			[reference('The `id` (preferred), address or current `slug`.')],
			ITEM_ERRORS,
		),
	},
} as const
