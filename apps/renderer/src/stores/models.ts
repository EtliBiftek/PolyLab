import { create } from "zustand";

import {
  createProvider,
  deleteProvider,
  deleteModel,
  createGroup,
  deleteGroup,
  listGroups,
  updateGroup,
  listModels,
  listProviders,
  testProvider,
  updateModel,
  updateProvider,
  upsertModel,
  listRemoteModels,
  type GroupDetail,
  type Model,
  type Provider,
  type RemoteModel,
  type TestResult,
} from "../lib/api";

interface ModelsState {
  providers: Provider[];
  models: Model[];
  groups: GroupDetail[];
  loaded: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  addProvider: (body: {
    kind: string;
    name?: string;
    base_url?: string;
    api_key?: string;
  }) => Promise<Provider>;
  removeProvider: (id: string) => Promise<void>;
  setProviderKey: (id: string, apiKey: string) => Promise<void>;
  test: (id: string) => Promise<TestResult>;
  fetchRemoteModels: (id: string) => Promise<RemoteModel[]>;
  addModel: (providerId: string, modelId: string) => Promise<void>;
  removeModel: (id: string) => Promise<void>;
  addGroup: (body: { name: string; description?: string; model_ids: string[] }) => Promise<void>;
  editGroup: (id: string, body: { name?: string; model_ids?: string[] }) => Promise<void>;
  removeGroup: (id: string) => Promise<void>;
  /** Per-model think (reasoning) toggle; optimistic, rolled back on error. */
  setThink: (id: string, enabled: boolean) => Promise<void>;
  /** Model settings editor (name/color/temperature/max tokens/enabled). */
  patchModel: (
    id: string,
    body: Partial<Pick<Model, "display_name" | "color" | "temperature" | "max_tokens" | "enabled">>,
  ) => Promise<void>;
}

export const useModels = create<ModelsState>((set, get) => ({
  providers: [],
  models: [],
  groups: [],
  loaded: false,
  loading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const [providers, models, groups] = await Promise.all([
        listProviders(),
        listModels(),
        listGroups().catch(() => []),
      ]);
      set({ providers, models, groups, loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  addGroup: async (body) => {
    await createGroup(body);
    await get().refresh();
  },

  editGroup: async (id, body) => {
    await updateGroup(id, body);
    await get().refresh();
  },

  removeGroup: async (id) => {
    await deleteGroup(id);
    await get().refresh();
  },

  addProvider: async (body) => {
    const provider = await createProvider(body);
    await get().refresh();
    return provider;
  },

  removeProvider: async (id) => {
    await deleteProvider(id);
    await get().refresh();
  },

  setProviderKey: async (id, apiKey) => {
    await updateProvider(id, { api_key: apiKey });
    await get().refresh();
  },

  test: (id) => testProvider(id),

  fetchRemoteModels: (id) => listRemoteModels(id),

  addModel: async (providerId, modelId) => {
    await upsertModel({ provider_id: providerId, model_id: modelId });
    await get().refresh();
  },

  removeModel: async (id) => {
    await deleteModel(id);
    await get().refresh();
  },

  patchModel: async (id, body) => {
    await updateModel(id, body);
    await get().refresh();
  },

  setThink: async (id, enabled) => {
    const before = get().models;
    set({
      models: before.map((model) =>
        model.id === id ? { ...model, reasoning_enabled: enabled } : model,
      ),
    });
    try {
      const updated = await updateModel(id, { reasoning_enabled: enabled });
      set({ models: get().models.map((m) => (m.id === id ? { ...m, ...updated } : m)) });
    } catch (error) {
      set({ models: before });
      throw error;
    }
  },
}));
