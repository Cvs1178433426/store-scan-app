import nextVitals from "eslint-config-next/core-web-vitals";

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...nextVitals,
  {
    // Next 16 / eslint-plugin-react-hooks 신규칙 — 데이터 fetch·localStorage hydration용
    // useEffect 안 setState를 전면 금지한다. 기존 앱 전체가 걸려 별도 리팩터 전까지 끈다.
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "out/**"],
  },
];

export default eslintConfig;
