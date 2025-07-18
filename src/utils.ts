export const fmt = (value: number): string => {
  return value.toFixed(1);
};

export const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
