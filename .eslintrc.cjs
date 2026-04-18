module.exports = {
  root: true,
  ignorePatterns: [
    "artifacts/**",
    "build/**",
    "cache/**",
    "coverage/**",
    "deployments/**",
    "edr-cache/**",
    "node_modules/**",
    "reports/**",
    "scripts/deployments/**",
    "typechain-types/**",
    "Volumes/**",
    "**/*.json",
    "**/*.md",
    "**/*.sol"
  ],
  overrides: [
    {
      files: ["**/*.ts"],
      parser: "@typescript-eslint/parser",
      plugins: ["@typescript-eslint"],
      extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      },
      env: {
        es2022: true,
        node: true
      },
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/no-unused-vars": "off",
        "@typescript-eslint/no-unused-expressions": "off",
        "@typescript-eslint/no-require-imports": "off",
        "@typescript-eslint/ban-ts-comment": "off",
        "no-extra-boolean-cast": "off",
        "prefer-const": "off",
        "no-unexpected-multiline": "off",
        "no-unsafe-finally": "off",
        "no-empty": "off",
        "no-constant-condition": "off",
        "no-useless-escape": "off",
        "no-useless-catch": "off",
        "no-inner-declarations": "off"
      }
    },
    {
      files: ["**/*.{js,cjs,mjs}"],
      extends: ["eslint:recommended"],
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "script"
      },
      env: {
        es2022: true,
        node: true
      },
      rules: {
        "no-unused-vars": "off",
        "no-inner-declarations": "off"
      }
    },
    {
      files: ["**/*.{test,spec}.{ts,js,cjs,mjs}", "test/**", "tests/**"],
      env: {
        jest: true,
        mocha: true
      }
    }
  ]
}
