module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "./tsconfig.json",
    ecmaVersion: 2020,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
  ],
  rules: {
    // Enforce explicit return types on public API methods
    "@typescript-eslint/explicit-module-boundary-types": "warn",
    // Prevent accidental any usage
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-call": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    // Enforce consistent usage of type imports
    "@typescript-eslint/consistent-type-imports": [
      "error",
      { prefer: "type-imports" },
    ],
    // Prevent floating promises
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    // General code quality
    "no-console": "warn",
    "prefer-const": "error",
    "no-var": "error",
  },
  env: {
    browser: true,
    es2020: true,
  },
  ignorePatterns: ["dist/**", "node_modules/**", "jest.config.ts"],
};
