/**
 * The public catalog contract. Hub's public queries return whole documents,
 * including audit and moderation fields, so every response is built field by
 * field here: a field added to a Hub document stays private until it is added
 * to one of these views.
 */

const DEFAULT_BEDROCK_PORT = 19_132

export interface CategoryDoc {
	_id: string
	description?: string
	name: string
	slug: string
}

interface UserOwner {
	displayUsername?: string
	image?: string
	type: 'user'
	username?: string
}

interface OrganizationOwner {
	logo?: string | null
	name: string
	slug: string
	type: 'organization'
}

type OwnerDoc = OrganizationOwner | UserOwner | null | undefined

interface AddonMetadata {
	behaviorPackIncluded: boolean
	dependencies: Array<{ name: string; url?: string }>
	experimentalFeaturesRequired: boolean
	resourcePackIncluded: boolean
	type: 'addon'
}

interface ResourcePackMetadata {
	contentTypes: string[]
	resolution: string
	type: 'resource_pack'
}

/** An add-on or resource pack; Hub stores both in its `projects` table. */
export interface ContentDoc {
	_id: string
	averageRating?: number
	bannerUrl?: string | null
	categories?: CategoryDoc[]
	credits?: Array<{ name: string; role: string; url?: string }>
	description?: string
	discordUrl?: string
	donationUrl?: string
	favouriteCount?: number
	iconUrl?: string | null
	issueTrackerUrl?: string
	latestVersion?: {
		createdAt: number
		fileName?: string
		fileSize?: number
		gameVersions?: string[]
		version: string
	} | null
	latestVersionAt?: number
	latestVersionString?: string
	license?: string
	licenseCustom?: string
	metadata?: AddonMetadata | ResourcePackMetadata
	name: string
	owner?: OwnerDoc
	publishedAt?: number
	reviewCount?: number
	slug: string
	sourceUrl?: string
	summary: string
	supportedGameVersions?: string[]
	tags?: string[]
	totalDownloads?: number
	type: string
	updatedAt?: number
	websiteUrl?: string
	wikiUrl?: string
}

export interface ContentReleaseDoc {
	_id: string
	changelog?: string
	createdAt: number
	downloads?: number
	fileName?: string
	fileSize?: number
	gameVersions?: string[]
	project?: { type: string }
	version: string
}

export interface PluginCardDoc {
	categories?: Array<{ name: string; slug: string }>
	creator?: {
		avatarUrl?: string
		displayName: string
		username: string
	} | null
	iconUrl?: string
	latestVersion?: {
		publishedAt?: number
		verifiedBuild: boolean
		version: string
	} | null
	license?: string
	name: string
	organization?: { avatarUrl?: string; name: string; slug: string } | null
	publicId: string
	publishedAt?: number
	ratingAverage?: number
	ratingCount?: number
	slug: string
	software: { name: string; slug: string }
	summary: string
	updatedAt?: number
}

export interface PluginVersionDoc {
	changelog?: string
	minecraftVersion?: string
	normalizedVersion: string
	publishedAt?: number
	release?: {
		asset?: { name: string; sha256?: string; size: number } | null
		build?: { logsUrl?: string } | null
		commitSha?: string
		githubReleaseUrl?: string
		verifiedBuild?: boolean
	} | null
	version: string
}

export interface PluginDoc {
	description?: string
	licenseCustom?: string
	links?: {
		discord?: string
		donation?: string
		issues?: string
		website?: string
		wiki?: string
	}
	project: PluginCardDoc
	repository: { defaultBranch: string; fullName: string; htmlUrl: string }
	versions: PluginVersionDoc[]
}

export interface ServerDoc {
	_id: string
	averageRating?: number
	bannerUrl?: string | null
	categories?: CategoryDoc[]
	description?: string
	discordUrl?: string
	favouriteCount?: number
	gameVersions?: string[]
	ipAddress: string
	language?: string[]
	logoUrl?: string | null
	maxPlayers?: number
	name: string
	online?: boolean
	owner?: OwnerDoc
	playerCount?: number
	port: number
	publishedAt?: number
	region?: string
	reviewCount?: number
	slug: string
	smallDescription: string
	software?: { name: string; slug: string } | null
	storeUrl?: string
	tags?: string[]
	updatedAt?: number
	verifiedAt?: number
	website?: string
	wikiUrl?: string
}

export interface GameVersionDoc {
	version: string
}

export interface SoftwareDoc {
	description?: string
	logoUrl?: string
	name: string
	repositoryUrl?: string
	slug: string
	websiteUrl?: string
}

function toTimestamp(epochMs: number | undefined) {
	return epochMs === undefined ? null : new Date(epochMs).toISOString()
}

function hubUrlFor(hubUrl: string, path: string) {
	return new URL(path, hubUrl).toString()
}

/** Resource packs stored before the rename still have the old type. */
export function toContentType(type: string) {
	return type === 'texture_pack' ? 'resource_pack' : type
}

function toMetadata(metadata: ContentDoc['metadata']) {
	if (metadata?.type === 'addon') {
		return {
			behaviorPackIncluded: metadata.behaviorPackIncluded,
			dependencies: metadata.dependencies.map(({ name, url }) => ({
				name,
				url: url ?? null,
			})),
			experimentalFeaturesRequired: metadata.experimentalFeaturesRequired,
			resourcePackIncluded: metadata.resourcePackIncluded,
		}
	}
	if (metadata?.type === 'resource_pack') {
		return {
			contentTypes: metadata.contentTypes,
			resolution: metadata.resolution,
		}
	}
	return null
}

function toOwner(owner: OwnerDoc) {
	if (owner?.type === 'organization') {
		return {
			displayName: owner.name,
			imageUrl: owner.logo ?? null,
			slug: owner.slug,
			type: owner.type,
		}
	}
	if (owner?.type === 'user') {
		return {
			displayName: owner.displayUsername ?? owner.username ?? null,
			imageUrl: owner.image ?? null,
			slug: owner.username ?? null,
			type: owner.type,
		}
	}
	return null
}

function toCategorySummary({ name, slug }: { name: string; slug: string }) {
	return { name, slug }
}

export function toCategoryView(category: CategoryDoc) {
	return {
		description: category.description ?? null,
		name: category.name,
		slug: category.slug,
	}
}

/** Hub links by stable ID, since slugs can be edited. */
function contentPagePath(type: string, id: string) {
	return type === 'addon' ? `/addons/a_${id}` : `/resource-packs/rp_${id}`
}

export function toContentSummary(content: ContentDoc, hubUrl: string) {
	return {
		bannerUrl: content.bannerUrl ?? null,
		categories: (content.categories ?? []).map(toCategorySummary),
		gameVersions: content.supportedGameVersions ?? [],
		iconUrl: content.iconUrl ?? null,
		id: content._id,
		latestVersion: content.latestVersionString ?? null,
		latestVersionAt: toTimestamp(content.latestVersionAt),
		metadata: toMetadata(content.metadata),
		name: content.name,
		publishedAt: toTimestamp(content.publishedAt),
		slug: content.slug,
		stats: {
			averageRating: content.averageRating ?? 0,
			downloads: content.totalDownloads ?? 0,
			favourites: content.favouriteCount ?? 0,
			reviews: content.reviewCount ?? 0,
		},
		summary: content.summary,
		tags: content.tags ?? [],
		updatedAt: toTimestamp(content.updatedAt),
		url: hubUrlFor(
			hubUrl,
			contentPagePath(toContentType(content.type), content._id),
		),
	}
}

export function toContentDetail(content: ContentDoc, hubUrl: string) {
	return {
		...toContentSummary(content, hubUrl),
		credits: (content.credits ?? []).map(({ name, role, url }) => ({
			name,
			role,
			url: url ?? null,
		})),
		description: content.description ?? '',
		license: content.license ?? null,
		licenseCustom: content.licenseCustom ?? null,
		links: {
			discord: content.discordUrl ?? null,
			donation: content.donationUrl ?? null,
			issues: content.issueTrackerUrl ?? null,
			source: content.sourceUrl ?? null,
			website: content.websiteUrl ?? null,
			wiki: content.wikiUrl ?? null,
		},
		owner: toOwner(content.owner),
	}
}

/** Downloads stay on Hub's route, which applies availability rules and counts. */
export function toContentRelease(release: ContentReleaseDoc, hubUrl: string) {
	return {
		changelog: release.changelog ?? '',
		downloads: release.downloads ?? 0,
		downloadUrl: hubUrlFor(
			hubUrl,
			`/api/projects/versions/${encodeURIComponent(release._id)}/download`,
		),
		fileName: release.fileName ?? null,
		fileSize: release.fileSize ?? null,
		gameVersions: release.gameVersions ?? [],
		publishedAt: toTimestamp(release.createdAt),
		sha256: null,
		version: release.version,
	}
}

function toPluginOwner({ creator, organization }: PluginCardDoc) {
	if (organization) {
		return {
			displayName: organization.name,
			imageUrl: organization.avatarUrl ?? null,
			slug: organization.slug,
			type: 'organization' as const,
		}
	}
	if (creator) {
		return {
			displayName: creator.displayName,
			imageUrl: creator.avatarUrl ?? null,
			slug: creator.username,
			type: 'user' as const,
		}
	}
	return null
}

export function toPluginSummary(plugin: PluginCardDoc, hubUrl: string) {
	return {
		categories: (plugin.categories ?? []).map(toCategorySummary),
		iconUrl: plugin.iconUrl ?? null,
		id: plugin.publicId,
		latestVersion: plugin.latestVersion?.version ?? null,
		latestVersionAt: toTimestamp(plugin.latestVersion?.publishedAt),
		license: plugin.license ?? null,
		name: plugin.name,
		owner: toPluginOwner(plugin),
		publishedAt: toTimestamp(plugin.publishedAt),
		slug: plugin.slug,
		software: {
			name: plugin.software.name,
			slug: plugin.software.slug,
		},
		stats: {
			averageRating: plugin.ratingAverage ?? 0,
			reviews: plugin.ratingCount ?? 0,
		},
		summary: plugin.summary,
		updatedAt: toTimestamp(plugin.updatedAt),
		url: hubUrlFor(hubUrl, `/plugins/${plugin.publicId}`),
	}
}

export function toPluginDetail(plugin: PluginDoc, hubUrl: string) {
	return {
		...toPluginSummary(plugin.project, hubUrl),
		description: plugin.description ?? '',
		licenseCustom: plugin.licenseCustom ?? null,
		links: {
			discord: plugin.links?.discord ?? null,
			donation: plugin.links?.donation ?? null,
			issues: plugin.links?.issues ?? null,
			website: plugin.links?.website ?? null,
			wiki: plugin.links?.wiki ?? null,
		},
		repository: {
			defaultBranch: plugin.repository.defaultBranch,
			fullName: plugin.repository.fullName,
			url: plugin.repository.htmlUrl,
		},
	}
}

/** The same shape as other releases, plus how the plugin's file was built. */
export function toPluginRelease(
	publicId: string,
	version: PluginVersionDoc,
	hubUrl: string,
) {
	const release = version.release
	const asset = release?.asset

	return {
		buildLogsUrl: release?.build?.logsUrl ?? null,
		changelog: version.changelog ?? '',
		commitSha: release?.commitSha ?? null,
		downloadUrl: asset
			? hubUrlFor(
					hubUrl,
					`/plugins/${publicId}/download/${encodeURIComponent(version.normalizedVersion)}`,
				)
			: null,
		fileName: asset?.name ?? null,
		fileSize: asset?.size ?? null,
		gameVersions: version.minecraftVersion ? [version.minecraftVersion] : [],
		githubReleaseUrl: release?.githubReleaseUrl ?? null,
		publishedAt: toTimestamp(version.publishedAt),
		sha256: asset?.sha256 ?? null,
		verifiedBuild: release?.verifiedBuild ?? false,
		version: version.version,
	}
}

/** Hub links servers by address, leaving out the default Bedrock port. */
function serverPagePath({ ipAddress, port }: ServerDoc) {
	const host = ipAddress.trim().replace(/\.$/, '').toLowerCase()
	return `/server/${port === DEFAULT_BEDROCK_PORT ? host : `${host}:${port}`}`
}

export function toServerSummary(server: ServerDoc, hubUrl: string) {
	return {
		address: { host: server.ipAddress, port: server.port },
		bannerUrl: server.bannerUrl ?? null,
		categories: (server.categories ?? []).map(toCategorySummary),
		gameVersions: server.gameVersions ?? [],
		id: server._id,
		languages: server.language ?? [],
		logoUrl: server.logoUrl ?? null,
		name: server.name,
		publishedAt: toTimestamp(server.publishedAt),
		region: server.region ?? null,
		slug: server.slug,
		stats: {
			averageRating: server.averageRating ?? 0,
			favourites: server.favouriteCount ?? 0,
			reviews: server.reviewCount ?? 0,
		},
		status: {
			maxPlayers: server.maxPlayers ?? null,
			online: server.online ?? null,
			players: server.playerCount ?? 0,
		},
		summary: server.smallDescription,
		tags: server.tags ?? [],
		updatedAt: toTimestamp(server.updatedAt),
		url: hubUrlFor(hubUrl, serverPagePath(server)),
		verified: server.verifiedAt !== undefined,
	}
}

export function toServerDetail(server: ServerDoc, hubUrl: string) {
	return {
		...toServerSummary(server, hubUrl),
		description: server.description ?? '',
		links: {
			discord: server.discordUrl ?? null,
			store: server.storeUrl ?? null,
			website: server.website ?? null,
			wiki: server.wikiUrl ?? null,
		},
		owner: toOwner(server.owner),
		software: server.software
			? { name: server.software.name, slug: server.software.slug }
			: null,
	}
}

export function toSoftwareView(software: SoftwareDoc) {
	return {
		description: software.description ?? '',
		logoUrl: software.logoUrl ?? null,
		name: software.name,
		repositoryUrl: software.repositoryUrl ?? null,
		slug: software.slug,
		websiteUrl: software.websiteUrl ?? null,
	}
}
