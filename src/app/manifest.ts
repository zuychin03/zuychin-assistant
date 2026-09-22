import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
    return {
        name: "Zuychin Assistant",
        short_name: "Zuychin",
        description: "Personal AI assistant for research, coding and planning.",
        start_url: "/",
        display: "standalone",
        background_color: "#0f172a",
        theme_color: "#0f172a",
        icons: [
            { src: "/icons/icon-192.png?v=b879353ceb1b", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png?v=711679e99f1f", sizes: "512x512", type: "image/png" },
            { src: "/icons/icon-maskable-512.png?v=52926d2b90cb", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
    };
}
