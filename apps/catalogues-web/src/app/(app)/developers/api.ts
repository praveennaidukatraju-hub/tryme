import type {
  ApiKey,
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiUsageResponse,
} from '@tryme/types';
import { api } from '@/lib/api';

export type { ApiKey, ApiKeyCreateResponse as CreatedApiKey };

export function listApiKeys(): Promise<ApiKeyListResponse> {
  return api.get<ApiKeyListResponse>('/v1/merchant/api-keys');
}

export function createApiKey(
  label: string,
  kind?: 'wordpress_widget',
  siteUrl?: string,
): Promise<ApiKeyCreateResponse> {
  return api.post<ApiKeyCreateResponse>('/v1/merchant/api-keys', { label, kind, siteUrl });
}

export function revokeApiKey(id: string): Promise<void> {
  return api.del<void>(`/v1/merchant/api-keys/${id}`);
}

export function getApiUsage(): Promise<ApiUsageResponse> {
  return api.get<ApiUsageResponse>('/v1/merchant/api-usage');
}
