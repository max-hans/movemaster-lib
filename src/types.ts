export type Position = {
  x: number;
  y: number;
  z: number;
  p: number;
  r: number;
};

export enum ROBOT_ERRORS {
  HARDWARE_ERROR = 1,
  COMMAND_ERROR = 2,
  UNKNOWN_ERROR = 99,
}
