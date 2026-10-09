import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.XUNZHAN_DIST || ".next",
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  serverExternalPackages: ["teleproto", "big-integer"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
