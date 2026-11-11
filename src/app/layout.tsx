import type { Metadata } from "next";
import { Azeret_Mono, Hanken_Grotesk } from "next/font/google";
import "./globals.css";
import { OfflinePrivacyBoundary } from "@/lib/offline/privacy-boundary";

const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
});

const azeret = Azeret_Mono({
  variable: "--font-azeret",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zuychin Assistant",
  description: "Personal AI assistant",
  icons: {
    icon: "/favicon.svg?v=291360ae65a9",
    apple: "/apple-touch-icon.png?v=aca5b8cc139b",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${hanken.variable} ${azeret.variable}`} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('zuychin-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`,
          }}
        />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <OfflinePrivacyBoundary />
        {children}
      </body>
    </html>
  );
}
