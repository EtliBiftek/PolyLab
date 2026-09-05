import { useEffect } from "react";

import { Composer } from "../components/chat/Composer";
import { EmptyState } from "../components/chat/EmptyState";
import { MessageList } from "../components/chat/MessageList";
import { RightPanel } from "../components/layout/RightPanel";
import { ApprovalToast } from "../components/chat/AgentView";
import { Sidebar } from "../components/layout/Sidebar";
import { TopBar } from "../components/layout/TopBar";
import { SettingsModal } from "../components/settings/SettingsModal";
import { useModels } from "../stores/models";
import { useChat } from "../stores/chat";
import { useSettings } from "../stores/settings";
import { useBackendConnection } from "./useBackendConnection";

/**
 * Shell: sidebar / conversation area / optional right panel. When a conversation is
 * active the center shows its messages; otherwise the welcome empty state.
 */
export default function App() {
  useBackendConnection();

  const rightPanelOpen = useSettings((state) => state.rightPanelOpen);
  const theme = useSettings((state) => state.theme);
  const activeId = useChat((state) => state.activeId);
  const activeConversation = useChat((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeId),
  );
  const pendingApproval = useChat((state) => state.pendingApproval);
  const resolveApproval = useChat((state) => state.resolveApproval);

  // Apply the black/white theme on mount + change (settings → appearance).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const messages = useChat((state) => (activeId != null ? state.messages[activeId] : undefined));
  const streaming =
    activeId != null ? useChat((state) => state.streaming[activeId]) : undefined;
  const models = useModels((state) => state.models);
  const refreshModels = useModels((state) => state.refresh);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg-0 text-txt-0">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex min-h-0 flex-1 flex-col">
          {activeId != null ? (
            <>
              <div className="flex-1 overflow-y-auto">
                <MessageList
                  messages={messages ?? []}
                  streaming={streaming}
                  models={models}
                  group={activeConversation?.selection_type === "group"}
                  coding={activeConversation?.mode === "coding"}
                />
              </div>
              <Composer />
            </>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto">
                <EmptyState />
              </div>
              <Composer />
            </>
          )}
        </main>
      </div>

      {rightPanelOpen && <RightPanel />}
      {pendingApproval != null && (
        <ApprovalToast approval={pendingApproval} onResolve={resolveApproval} />
      )}
      <SettingsModal />
    </div>
  );
}
