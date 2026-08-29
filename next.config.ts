import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production", // Disable in dev to avoid Turbopack conflicts
});

const nextConfig = {
  // To silence the Turbopack build error when it detects Webpack plugins:
  turbopack: {},
};

export default withSerwist(nextConfig);