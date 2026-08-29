import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Offline Order Management System",
    short_name: "OrderManager",
    description: "Offline-first, local-centric order parsing and tracking for micro-enterprises",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#121212",
    theme_color: "#0f172a",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any"
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any"
      }
    ]
  };
}
