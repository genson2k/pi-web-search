import type { AuthStorage, FetchImpl } from "../auth";
import type { StructuredQuery } from "../query";
import type { SearchProviderId, SearchResponse } from "../types";

export interface SearchParams {
  query: string;
  parsedQuery?: StructuredQuery;
  limit?: number;
  numSearchResults?: number;
  recency?: "day" | "week" | "month" | "year";
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: FetchImpl;
  authStorage: AuthStorage;
  sessionId?: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  explicit?: boolean;
}
export abstract class SearchProvider {
  abstract readonly id: SearchProviderId;
  abstract readonly label: string;
  abstract isAvailable(auth: AuthStorage): boolean | Promise<boolean>;
  isExplicitlyAvailable(auth: AuthStorage): boolean | Promise<boolean> {
    return this.isAvailable(auth);
  }
  abstract search(params: SearchParams): Promise<SearchResponse>;
}
