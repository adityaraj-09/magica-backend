export type WaitpointApproval = "approved" | "rejected" | "expired";

export type WaitpointGateway = {
  awaitApproval(input: {
    type: "PLAN" | "CREDIT" | "MEDIA";
    run: { id: string; chatId: string; userId: string };
    idempotencyKey: string;
    payload: unknown;
    timeout: string;
  }): Promise<WaitpointApproval>;
};
