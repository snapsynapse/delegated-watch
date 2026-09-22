export const isSupportedNodeVersion = (version) => {
  const [major, minor] = version.split(".").map(Number);
  return (major === 24 && minor >= 18) || major === 26;
};
