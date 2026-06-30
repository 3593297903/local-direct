import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      boxShadow: {
        soft: "0 20px 70px rgba(0, 0, 0, 0.28)",
        neon: "0 0 34px rgba(34, 211, 238, 0.18)",
      },
      borderRadius: {
        '4xl': '2rem'
      }
    },
  },
  plugins: [],
};
export default config;
