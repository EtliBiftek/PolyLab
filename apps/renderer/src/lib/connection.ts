/** App-wide connection singletons: one WS client, shared with every store. */
import { WsClient } from "./ws";
import { backendInfo } from "./backend";

let client: WsClient | null = null;

/** Creates (once) and returns the shared WsClient. */
export function wsClient(): WsClient {
  if (client == null) {
    const info = backendInfo();
    client = new WsClient(info.wsUrl, info.token);
  }
  return client;
}

/** Test hook: inject a fake client. */
export function setWsClientForTests(fake: WsClient | null): void {
  client = fake;
}
