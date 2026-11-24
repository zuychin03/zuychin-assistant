import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
    return {
        name: "Zuychin Assistant",
        short_name: "Zuychin",
        description: "Personal AI assistant for research, coding and planning.",
        start_url: "/",
        display: "standalone",
        // Android reads this only when the app is installed, so a change needs a reinstall.
        share_target: {
            action: "/capture/share", method: "POST", enctype: "multipart/form-data",
            params: { title: "title", text: "text", url: "url", files: [{ name: "files", accept: ["image/*", "application/pdf"] }] },
        },
        background_color: "#0f1115",
        theme_color: "#0f1115",
        icons: [
            { src: "/icons/icon-192.png?v=b879353ceb1b", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png?v=711679e99f1f", sizes: "512x512", type: "image/png" },
            { src: "/icons/icon-maskable-512.png?v=52926d2b90cb", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
    };
}
