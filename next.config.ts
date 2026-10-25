import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // The dev server binds 0.0.0.0. Next 16 blocks /_next for other hostnames,
  // including a browser opened at 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  cacheComponents: true,
  partialPrefetching: true,
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
