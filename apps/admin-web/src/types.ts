export type GenderSlug = 'men' | 'women' | 'boys' | 'girls';

// Free-form slug, admin-defined (see ContinentSlug in @tryme/types) — not a
// fixed set. apps/admin-web/src/lib/continents.ts holds the preset list plus
// slugify/label helpers.
export type Continent = string;

export interface ModelFace {
  id: string;
  gender: GenderSlug;
  continent: Continent | null;
  label: string;
  thumbnailKey: string;
  thumbnailUrl: string | null;
  r2Key: string;
  r2Url: string | null;
  faceSideR2Key: string | null;
  tags: string[];
  /** Non-null = published to the public developer API under this slug. */
  publicApiSlug: string | null;
  isActive: boolean;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelBackground {
  id: string;
  label: string;
  thumbnailKey: string;
  thumbnailUrl: string | null;
  r2Key: string;
  r2Url: string | null;
  bgComfyR2Key: string | null;
  categoryId: number | null;
  tags: string[];
  specialTag: CategoryTag | null;
  publicApiSlug: string | null;
  isActive: boolean;
  isWhiteBg: boolean;
  sortOrder: number;
  genderSlug: string | null;
  scope: 'general' | 'template';
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GarmentType {
  id: string;
  genderSlug: GenderSlug;
  slug: string;
  label: string;
  thumbnailKey?: string | null;
  thumbnailUrl?: string | null;
  instructionImageKey?: string | null;
  instructionImageUrl?: string | null;
  isActive: boolean;
  sortOrder: number;
  requiresLowerUpload: boolean;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
  tryonCategoryId?: string | null;
  defaultPoseId: string | null;
  requiresMannequinStep?: boolean;
  mannequinWorkflowTemplateId?: string | null;
  sareeStep2WorkflowTemplateId?: string | null;
  mannequinTwoInputWorkflowTemplateId?: string | null;
  twoInputTryonWorkflowTemplateId?: string | null;
  upperUploadLabel?: string | null;
  lowerUploadLabel?: string | null;
  requiresThirdUpload?: boolean;
  thirdUploadLabel?: string | null;
  publicApiSlug?: string | null;
  createdAt: string;
  updatedAt: string;
  poseCount?: number;
}

export interface WorkflowOption {
  id: string; // UUID from workflow_templates table
  slug: string;
  label: string;
  workflowType: 'regular' | 'tryon' | 'saree_step1' | 'saree_step1_two_input' | 'two_stage';
  isActive: boolean;
  poseCount: number;
  defaultFacePhasePrompt: string;
  defaultGarmentPhasePrompt: string;
  regenerationReasonPrompts: { reason: string; prompt: string }[];
  facePhasePromptNode: string | null;
  // two_stage only — stage 1's own prompt pair (stage 2's reuses the fields above)
  stage1PositivePromptNode: string | null;
  stage1NegativePromptNode: string | null;
  defaultStage1PositivePrompt: string;
  defaultStage1NegativePrompt: string;
  ksamplerNodes: {
    nodeId: string;
    steps: number | null;
    cfg: number | null;
    denoise: number | null;
    seed: number | null;
  }[];
  lowerNodeId: string | null;
  shoeNodeId: string | null;
  thirdNodeId: string | null;
  sizeNodeIds: string[];
  tryonPersonNodeId: string | null;
  tryonGarmentNodeId: string | null;
  tryonGarmentNodeId2: string | null;
  tryonOutputNodeId: string | null;
  version?: number;
  funnelCount?: number;
  draining?: { fromVersion: number } | null;
  createdAt: string;
}

export interface CatalogueTemplate {
  id: string;
  genderSlug: GenderSlug;
  label: string;
  thumbnailKey: string | null;
  thumbnailUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  lookCount: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogueTemplateLook {
  id: string;
  poseAssetId: string;
  backgroundId: string;
  sortOrder: number;
}

export interface TemplateGarmentTypeMapping {
  id: string;
  label: string;
  thumbnailUrl: string | null;
  mapped: boolean;
  mappingId: string | null;
  poseAssetIds: string[];
}

export interface MappedTemplatePoseWorkflow {
  id: string;
  label: string;
  displayName: string | null;
  thumbnailUrl: string;
  workflowTemplateId: string | null;
  promptGarmentPhase: string | null;
  source: 'auto' | 'manual' | null;
}

export interface MappedTemplateLook {
  id: string;
  poseAssetId: string;
  poseLabel: string;
  poseThumbnailUrl: string;
  backgroundLabel: string;
  isEnabled: boolean;
}
export interface ShotTypeWorkflow {
  shotType: 'full' | 'half' | 'closeup';
  workflowTemplateId: string | null;
}

export type CategoryTag = 'featured' | 'trending' | 'popular';

export interface CatalogCategory {
  id: number;
  typeId: number;
  typeSlug: string;
  parentId: number | null;
  slug: string;
  label: string;
  genderSlug: string | null;
  thumbnailKey: string | null;
  thumbnailUrl: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface CatalogItem {
  id: string;
  categoryId: number | null;
  type: 'lower' | 'shoe';
  genderSlug: string | null;
  label: string;
  thumbnailKey: string;
  thumbnailUrl: string | null;
  r2Key: string;
  r2Url: string | null;
  publicApiSlug: string | null;
  isActive: boolean;
  sortOrder: number;
  subcategoryIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserMerchant {
  id: string;
  companyName: string;
  contactName: string;
  phone: string;
  businessAddress: string;
  isActive: boolean;
  demoData: boolean;
  jobRateLimitPerMin: number | null;
  logoKey: string | null;
  logoUrl: string | null;
}

export interface User {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  phone: string | null;
  tier: string;
  maxActiveDevices: number;
  isBanned: boolean;
  banReason: string | null;
  isAdmin: boolean;
  adminRole: string | null;
  hasPassword: boolean;
  hasShopifyStore: boolean;
  isMerchant?: boolean;
  signupSource?: 'admin' | 'android_google' | null;
  demoData?: boolean | null;
  balance: number;
  totalJobs: number;
  lastJobAt: string | null;
  createdAt: string;
  updatedAt: string;
  recentJobs?: {
    id: string;
    status: string;
    createdAt: string;
    startedAt?: string | null;
    completedAt?: string | null;
    creditsCharged: number;
    jobType: string;
  }[];
  merchant?: UserMerchant | null;
}

export interface CreditLedgerEntry {
  id: string;
  userId: string;
  delta: number;
  reason: string;
  jobId: string | null;
  adminId: string | null;
  createdAt: string;
}

export type JobStatus =
  | 'QUEUED'
  | 'PREPROCESSING'
  | 'GENERATING'
  | 'UPLOADING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'PENDING_MANNEQUIN';

export interface Job {
  id: string;
  userId?: string;
  userEmail?: string | null;
  status: JobStatus;
  priority: boolean;
  creditsCharged: number;
  workerId: string | null;
  attempts?: number;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
  faceLabel?: string | null;
  faceThumbnailUrl?: string | null;
  backgroundLabel?: string | null;
  poseLabel?: string | null;
  hasLower: boolean;
  hasShoe: boolean;
  jobType?: string;
  outputUrl?: string;
  userHint?: string;
  /** Non-null = this job was created by the regenerate flow, not a fresh submission. */
  parentJobId?: string | null;
}

export type WorkerStatus = 'IDLE' | 'BUSY' | 'DRAINING' | 'OFFLINE';

export interface Worker {
  id: string;
  status: WorkerStatus;
  lastSeen: string;
  completed: number;
  currentJob: string | null;
  uptime: string;
}

export interface LedgerEntry {
  ts: string;
  delta: number;
  reason: string;
  admin: string;
}

export interface Stats {
  jobsToday: number;
  jobsTodayDelta: number;
  creditsToday: number;
  creditsTodayDelta: number;
  activeUsersToday: number;
  activeUsersDelta: number;
  workersHealthy: number;
  workersTotal: number;
  queueDepth: number;
  failed24h: number;
  failed24hDelta: number;
  jobsPerDay: number[];
  jobsPerDayLabels: string[];
}

export interface CreditPlan {
  id: string;
  slug: string;
  name: string;
  subtext: string;
  credits: number;
  basePaise: number;
  isActive: boolean;
  isHighlighted: boolean;
  badge: string | null;
  sortOrder: number;
  queueStream: 'priority' | 'normal' | 'low';
  watermark: boolean;
  planType: 'catalogue' | 'tryon';
  perUnitPriceLabel: string | null;
  unitCountLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignupCampaign {
  id: string;
  code: string;
  name: string;
  bonusPercent: number;
  startAt: string;
  endAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPoseAsset {
  id: string;
  label: string;
  displayName: string | null;
  r2Key: string;
  r2Url: string | null;
  thumbnailKey: string;
  thumbnailUrl: string | null;
  genderSlug: string | null;
  workflowTemplateId: string | null;
  promptGarmentPhase: string | null;
  promptFacePhase: string | null;
  poseVariant: string | null;
  shotType: 'full' | 'half' | 'closeup' | null;
  publicApiSlug: string | null;
  scope: 'general' | 'template';
  isActive: boolean;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
}

export interface SareeMannequinStyle {
  id: string;
  label: string;
  previewImageKey: string | null;
  previewImageUrl: string | null;
  mannequinWorkflowTemplateId: string;
  mannequinTwoInputWorkflowTemplateId: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PoseGarmentConfig {
  id: string;
  isActive: boolean; // effective for this garment type: config.isActive ?? globalIsActive
  globalIsActive: boolean; // the pose asset's own flag (Pose Assets tab), shared by every garment type
  defaultWorkflowTemplateId: string | null;
  defaultPromptGarmentPhase: string | null;
  defaultPromptFacePhase: string | null;
  displayName: string | null;
  label: string;
  thumbnailKey: string;
  thumbnailUrl: string;
  config: {
    workflowTemplateId: string | null;
    promptGarmentPhase: string | null;
    promptFacePhase: string | null;
    isActive: boolean | null;
  } | null;
}

export type AdminRole = 'SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT';

export interface ToastItem {
  id: number;
  kind?: 'error' | 'warning' | 'success';
  title: string;
  body?: string;
}

export interface ContactRequest {
  id: string;
  userId: string | null;
  name: string;
  email: string;
  phone: string;
  source: string | null;
  message: string | null;
  attachmentKey: string | null;
  attachmentUrl: string | null;
  status: 'new' | 'read' | 'done';
  createdAt: string;
}

export interface TryonSample {
  id: string;
  categoryId: string;
  r2Key: string;
  thumbnailKey: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface TryonCategory {
  id: string;
  name: string;
  slug: string;
  workflowTemplateId: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  samples: TryonSample[];
}
