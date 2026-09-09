export default {
  'resources/templates/**': () => [],
  '*.{ts,mts,cts,vue}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,yaml,yml}': ['prettier --write'],
}