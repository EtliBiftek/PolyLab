import { create } from "zustand";

import {
  createProvider,
  deleteProvider,
  deleteModel,
  listModels,
  listProviders,
  testProvider,
  updateProvider,
  upsertModel,
  listRemoteModels,
  type Model,
  type Provider,
  type RemoteModel,
  type TestResult,
} from "../lib/api";

interface ModelsState {
  providers: Provider[];
  models: Model[];
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
}

export const useModels = create<ModelsState>((set, get) => ({
  providers: [],
  models: [],
  loaded: false,
  loading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const [providers, models] = await Promise.all([listProviders(), listModels()]);
      set({ providers, models, loaded: true });
    } finally {
      set({ loading: false });
    }
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
}));
