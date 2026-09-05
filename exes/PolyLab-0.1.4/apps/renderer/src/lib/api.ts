/** REST client for the sidecar (contract: docs/EVENTS.md §6). */
import { backendInfo } from "./backend";

/* ------------------------------------------------------------------ types -- */

export interface HealthResponse {
  status: string;
  name: string;
  version: string;
  uptime_secs: number;
}

export interface Provider {
  id: string;
  kind: string;
  name: string;
  base_url: string | null;
  enabled: boolean;
  created_at: string;
  has_api_key: boolean;
}

export interface Model {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  color: string | null;
  temperature: number | null;
  max_tokens: number | null;
  system_prompt_override: string | null;
  supports_vision: boolean;
  supports_tools: boolean;
  supports_reasoning: boolean;
  /** Think toggle: null = auto (follows supports_reasoning). */
  reasoning_enabled: boolean | null;
  enabled: boolean;
  provider_kind: string;
  provider_name: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  mode: "chat" | "coding";
  selection_type: "single" | "group";
  model_id: string | null;
  group_id: string | null;
  debate_settings_json: string | null;
  project_path: string | null;
  folder_id: string | null;
  pinned: boolean;
  agent_auto_approve: boolean;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning: string | null;
  model_id: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_estimated: boolean | null;
  attachments_json: string | null;
  created_at: string;
}

export interface RemoteModel {
  id: string;
  display_name: string;
  supports_tools: boolean | null;
  context_window: number | null;
  added: boolean;
}

export interface TestResult {
  ok: boolean;
  model_count: number | null;
  detail: string | null;
}

/* ----------------------------------------------------------------- errors -- */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl, token } = backendInfo();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body != null) headers.set("Content-Type", "application/json");

  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    let code = "http_error";
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; detail?: string } };
      if (body.error) {
        code = body.error.code ?? code;
        detail = body.error.detail ?? detail;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, code, detail);
  }
  const text = await response.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

/* ---------------------------------------------------------------- health -- */

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}

/* -------------------------------------------------------------- providers -- */

export function listProviders(): Promise<Provider[]> {
  return request<Provider[]>("/api/providers");
}

export function createProvider(body: {
  kind: string;
  name?: string;
  base_url?: string;
  api_key?: string;
}): Promise<Provider> {
  return request<Provider>("/api/providers", { method: "POST", body: JSON.stringify(body) });
}

export function updateProvider(
  id: string,
  body: { name?: string; base_url?: string; enabled?: boolean; api_key?: string },
): Promise<Provider> {
  return request<Provider>(`/api/providers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteProvider(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/providers/${id}`, { method: "DELETE" });
}

export function testProvider(id: string): Promise<TestResult> {
  return request<TestResult>(`/api/providers/${id}/test`);
}

export function listRemoteModels(id: string): Promise<RemoteModel[]> {
  return request<RemoteModel[]>(`/api/providers/${id}/remote-models`);
}

/* ----------------------------------------------------------------- models -- */

export function listModels(): Promise<Model[]> {
  return request<Model[]>("/api/models");
}

export function upsertModel(body: {
  provider_id: string;
  model_id: string;
  display_name?: string;
  supports_reasoning?: boolean;
  supports_vision?: boolean;
  supports_tools?: boolean;
}): Promise<Model> {
  return request<Model>("/api/models", { method: "POST", body: JSON.stringify(body) });
}

export function updateModel(
  id: string,
  body: Partial<
    Pick<Model, "display_name" | "temperature" | "max_tokens" | "enabled" | "reasoning_enabled">
  >,
): Promise<Model> {
  return request<Model>(`/api/models/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteModel(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/models/${id}`, { method: "DELETE" });
}

/* ---------------------------------------------------------- conversations -- */

export function listConversations(): Promise<Conversation[]> {
  return request<Conversation[]>("/api/conversations");
}

export function createConversation(body: {
  mode?: "chat" | "coding";
  model_id?: string | null;
  selection_type?: "single" | "group";
  group_id?: string | null;
  debate_settings?: DebateSettings;
}): Promise<Conversation> {
  return request<Conversation>("/api/conversations", { method: "POST", body: JSON.stringify(body) });
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return request<ConversationDetail>(`/api/conversations/${id}`);
}

export function updateConversation(
  id: string,
  body: {
    title?: string;
    model_id?: string | null;
    pinned?: boolean;
    folder_id?: string | null;
    mode?: "chat" | "coding";
    selection_type?: "single" | "group";
    group_id?: string | null;
    debate_settings?: DebateSettings;
    agent_auto_approve?: boolean;
    project_path?: string;
  },
): Promise<Conversation> {
  return request<Conversation>(`/api/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteConversation(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/conversations/${id}`, { method: "DELETE" });
}

/* --------------------------------------------------------------- settings -- */

export function getSettings(): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>("/api/settings");
}

export function putSetting(key: string, value: unknown): Promise<unknown> {
  return request<unknown>("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ key, value }),
  });
}

/* ------------------------------------------------------------------ Phase 2+ */

export interface DebateSettings {
  termination: "fixed" | "consensus";
  max_rounds: number;
  leader_model_id: string | null;
  show_names_to_models: boolean;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface GroupDetail extends Group {
  models: Model[];
}

export function listGroups(): Promise<GroupDetail[]> {
  return request<GroupDetail[]>("/api/groups");
}

export function createGroup(body: {
  name: string;
  description?: string;
  model_ids: string[];
}): Promise<GroupDetail> {
  return request<GroupDetail>("/api/groups", { method: "POST", body: JSON.stringify(body) });
}

export function updateGroup(
  id: string,
  body: { name?: string; description?: string; model_ids?: string[] },
): Promise<GroupDetail> {
  return request<GroupDetail>(`/api/groups/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteGroup(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/groups/${id}`, { method: "DELETE" });
}

export interface DebateTurn {
  id: string;
  debate_id: string;
  round: number;
  model_id: string;
  anon_label: string;
  content: string;
  reasoning: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  phase: "initial" | "critique" | "synthesis";
  consensus: boolean | null;
  created_at: string;
}

export interface DebateReplay {
  id: string;
  message_id: string;
  conversation_id: string;
  status: string;
  rounds_total: number;
  consensus_reached: boolean | null;
  leader_model_id: string | null;
  settings_json: string | null;
  total_tokens_in: number;
  total_tokens_out: number;
  started_at: string;
  ended_at: string | null;
  turns: DebateTurn[];
}

export function listDebates(query: {
  message_id?: string;
  conversation_id?: string;
}): Promise<DebateReplay[]> {
  const params = new URLSearchParams(
    Object.entries(query).filter((entry): entry is [string, string] => entry[1] != null),
  );
  return request<DebateReplay[]>(`/api/debates?${params.toString()}`);
}

/* --------------------------------------------------------- workspace (F4/F5) */

export interface FsResponse {
  root: string;
  path: string;
  content: string;
}

export function fsList(conversationId: string, path = ""): Promise<FsResponse> {
  return request<FsResponse>(
    `/api/fs?conversation_id=${encodeURIComponent(conversationId)}&op=list&path=${encodeURIComponent(path)}`,
  );
}

export function fsRead(conversationId: string, path: string): Promise<FsResponse> {
  return request<FsResponse>(
    `/api/fs?conversation_id=${encodeURIComponent(conversationId)}&op=read&path=${encodeURIComponent(path)}`,
  );
}

export interface GitResponse {
  repo: boolean;
  output: string;
}

export function gitOp(conversationId: string, op: "status" | "diff" | "log"): Promise<GitResponse> {
  return request<GitResponse>(
    `/api/git?conversation_id=${encodeURIComponent(conversationId)}&op=${op}`,
  );
}

/* ------------------------------------------------------- agent steps / folders */

export interface AgentStep {
  id: string;
  message_id: string;
  seq: number;
  tool: string;
  args_json: string;
  result: string | null;
  ok: boolean;
}

export function listAgentSteps(messageId: string): Promise<AgentStep[]> {
  return request<AgentStep[]>(`/api/agent-steps?message_id=${encodeURIComponent(messageId)}`);
}

export interface Folder {
  id: string;
  name: string;
  position: number;
}

export function listFolders(): Promise<Folder[]> {
  return request<Folder[]>("/api/folders");
}

export function createFolder(name: string): Promise<Folder> {
  return request<Folder>("/api/folders", { method: "POST", body: JSON.stringify({ name }) });
}

export function deleteFolder(id: string): Promise<void> {
  return request<void>(`/api/folders/${id}`, { method: "DELETE" });
}

export function gitCommit(conversationId: string, message: string): Promise<{ ok: boolean; output: string }> {
  return request<{ ok: boolean; output: string }>("/api/git", {
    method: "POST",
    body: JSON.stringify({ conversation_id: conversationId, message }),
  });
}
