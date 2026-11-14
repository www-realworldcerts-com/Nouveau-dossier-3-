import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep the standalone root at jarvis/ even though the repository root also
  // has a package.json, so server.js and the Docker/start paths stay correct.
  outputFileTracingRoot: process.cwd(),
  reactStrictMode: false,
};

export default nextConfig;
