import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
