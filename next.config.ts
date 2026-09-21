import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  serverExternalPackages: ["@prisma/client", "prisma", "@trigger.dev/sdk"],
};

export default nextConfig;
