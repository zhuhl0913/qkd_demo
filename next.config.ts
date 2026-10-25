import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Next matches the Origin hostname label by label. `*` is one whole label.
  // Phones on the LAN open http://192.168.x.x:3457 (or 10.x / 172.16–31.x);
  // without these, /_next is blocked. Restart `pnpm dev` after editing.
  // A hostname that is not an IP and not *.local still has to be added.
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "*.local",
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
  ],
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
