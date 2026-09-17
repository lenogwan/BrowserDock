/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,js,svelte,ts}"],
  theme: {
    extend: {
      colors: {
        dock: "#14141bcc",
        firefox: "#FF7139",
        mullvad: "#218838",
        chrome: "#4285F4",
        edge: "#0078D7"
      }
    }
  },
  plugins: []
};
