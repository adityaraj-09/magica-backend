import type { GeneratedAsset } from "@/agent/tools/types";

export type PutObjectInput = {
  key: string;
  body: Uint8Array;
  contentType: string;
};

export type PutObjectResult = {
  key: string;
  url: string;
  byteSize: number;
};

export type ObjectStore = {
  put(input: PutObjectInput): Promise<PutObjectResult>;
};

export type AssetGateway = {
  persist(input: {
    chatId: string;
    runId: string;
    toolCallId: string;
    assets: GeneratedAsset[];
    signal?: AbortSignal;
  }): Promise<GeneratedAsset[]>;
};
