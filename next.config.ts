import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` powers the Docker image; Vercel ignores it for its own
  // serverless build, so this is safe in both environments.
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
