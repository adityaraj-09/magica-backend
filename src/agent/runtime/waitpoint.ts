import type { WaitpointOverlay } from "./realtime";

export type WaitpointApproval = "approved" | "rejected" | "expired";

export type WaitpointKind = "PLAN" | "CREDIT" | "MEDIA";

export type WaitpointGateway = {
  awaitApproval(input: {
    type: WaitpointKind;
    run: { id: string; chatId: string; userId: string };
    idempotencyKey: string;
    payload: unknown;
    timeout: string;
    onOpen?: (overlay: WaitpointOverlay) => void | Promise<void>;
  }): Promise<WaitpointApproval>;
};
