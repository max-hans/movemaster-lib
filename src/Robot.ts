import { SerialPort } from "serialport";
import { type Position, ROBOT_ERRORS } from "./types";
import { delay, fmt } from "./utils";
import { portDefaults } from "./defaults";

class Robot {
  port: SerialPort | null = null;
  position: Position | null = null;
  toolIsOpen = false;
  toolLength = -1; // Default tool length
  speed = -1;
  portIsOpen = false;

  async connect(comPortName: string): Promise<void> {
    return new Promise((resolve, _error) => {
      this.port = new SerialPort({
        path: comPortName.trim(),
        ...portDefaults,
      });

      this.port.on("open", () => {
        console.log(`Connected to port: ${comPortName}`);
        resolve();
      });
      this.port.on("data", (data) => {
        console.log("Data received:", data.toString());
      });
      this.port.on("error", (err) => {
        console.error("Error on port:", err);
      });
    });
  }

  isConnected(): boolean {
    return !!this.port?.isOpen;
  }

  private checkPortOpen(): asserts this is this & { port: SerialPort } {
    if (!this.port || !this.port.isOpen) {
      throw new Error("Port is not open");
    }
  }

  async sendCommandNoAnswer(command: string): Promise<void> {
    this.checkPortOpen();

    console.log(`Sending command: ${command}`);
    this.port.write(command + "\r\n");
    await delay(100);
  }

  sendCommandWithAnswer(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.checkPortOpen();

      console.log(`Sending command with answer: ${command}`);

      let stringBuffer = "";
      this.port.write(command + "\r\n", (err) => {
        if (err) {
          console.error("Error writing to port:", err);
          return reject(err);
        }
      });

      this.port.on("data", (data) => {
        stringBuffer += data.toString();
        if (stringBuffer.endsWith("\r\n")) {
          const response = stringBuffer.trim();
          console.log("Response received:", response);
          resolve(response);
          stringBuffer = ""; // Reset buffer after processing
        }
      });
    });
  }

  async checkRobotErrorCode(): Promise<
    { ok: true } | { ok: false; error: ROBOT_ERRORS }
  > {
    this.checkPortOpen();
    const res = await this.sendCommandWithAnswer("ER");
    console.log("Error code response:", res);
    const errorCode = parseInt(res, 10);

    if (Number.isNaN(errorCode)) {
      console.error("Invalid error code received:", res);
      return { ok: false, error: ROBOT_ERRORS.UNKNOWN_ERROR };
    }

    switch (errorCode) {
      case 0:
        console.log("No error detected.");
        return { ok: true };
      case 1:
        console.error("Hardware error: 1");
        return { ok: false, error: ROBOT_ERRORS.HARDWARE_ERROR };
      case 2:
        console.error("Position or format error: 2");
        return { ok: false, error: ROBOT_ERRORS.COMMAND_ERROR };
    }
    return { ok: false, error: ROBOT_ERRORS.UNKNOWN_ERROR };
  }

  async moveTo(position: Position, interpolatePoints = 0): Promise<void> {
    this.checkPortOpen();

    const { x, y, z, p, r } = position;

    if (interpolatePoints === 0) {
      await this.sendCommandNoAnswer(
        `MP ${fmt(x)}, ${fmt(y)}, ${fmt(z)}, ${fmt(p)}, ${fmt(r)}`
      );
    } else {
      await this.sendCommandNoAnswer("PC 1");
      await this.sendCommandNoAnswer(
        `PD 1, ${fmt(x)}, ${fmt(y)}, ${fmt(z)}, ${fmt(p)}, ${fmt(r)}`
      );
      await this.sendCommandNoAnswer(
        `MS 1, ${interpolatePoints}, ${this.toolIsOpen ? "C" : "O"}`
      );
    }

    // Update cached position
    this.position = { x, y, z, p, r };
  }

  /**
   * Moves the robot arm to the given absolute x-y-z coordinates using current P and R values
   */
  async moveToXYZ(
    x: number,
    y: number,
    z: number,
    interpolatePoints = 0
  ): Promise<void> {
    if (!this.position) {
      throw new Error("Actual position not set");
    }

    return this.moveTo(
      {
        x,
        y,
        z,
        p: this.position.p,
        r: this.position.r,
      },
      interpolatePoints
    );
  }

  async getActualPosition(
    forceUpdateByHardware: boolean = true
  ): Promise<Position> {
    if (!forceUpdateByHardware && this.position) {
      // Return cached position (cloned to prevent mutation)
      return { ...this.position };
    }

    // Update from hardware
    const response = await this.sendCommandWithAnswer("WH");

    const parts = response.split(",").map((part) => {
      let cleaned = part.trim().replace("+", "");

      if (cleaned.startsWith(".")) {
        cleaned = `0${cleaned}`;
      }
      return parseFloat(cleaned);
    });
    if (parts.length < 5) {
      throw new Error("Invalid position response format");
    }

    const position = {
      x: parts[0],
      y: parts[1],
      z: parts[2],
      p: parts[3],
      r: parts[4],
    };
    this.position = position;

    return { ...position }; // Return cloned position
  }

  async setGripper(open: boolean): Promise<void> {
    this.checkPortOpen();

    if (open) {
      await this.sendCommandNoAnswer("GO");
    } else {
      await this.sendCommandNoAnswer("GC");
    }

    this.toolIsOpen = open;
  }
  async setSpeed(speed: number): Promise<void> {
    this.checkPortOpen();

    const roundedSpeed = Math.floor(speed);
    if (roundedSpeed < 0 || roundedSpeed > 9) {
      return Promise.reject(new Error("Speed must be between 0 and 9"));
    }
    this.speed = roundedSpeed;
    await this.sendCommandNoAnswer(`SP ${roundedSpeed}`);
  }

  async setToolLength(length: number): Promise<void> {
    this.checkPortOpen();
    this.toolLength = length;
    await this.sendCommandNoAnswer(`TL ${Math.floor(length)}`);
  }

  async withCheck<T>(result: Promise<T>): Promise<T> {
    const cbResult = await result;
    const errResult = await this.checkRobotErrorCode();
    if (errResult.ok) {
      return cbResult;
    } else {
      throw new Error(`Command errored: ${errResult.error}`);
    }
  }

  async movePath(points: Position[]): Promise<void> {
    const positionOffset = 1;
    this.checkPortOpen();

    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      await this.sendCommandNoAnswer(
        `PD ${i + positionOffset}, ${fmt(point.x)}, ${fmt(point.y)}, ${fmt(
          point.z
        )}, ${fmt(point.p)}, ${fmt(point.r)}`
      );
      await delay(100); // Delay between commands
    }

    await this.sendCommandNoAnswer(
      `MC ${positionOffset}, ${points.length - 1 + positionOffset}`
    );
  }

  /**
   * Moves all axes to zero position
   */
  async moveToHomePosition(): Promise<void> {
    this.checkPortOpen();
    await this.sendCommandNoAnswer("OG");
  }

  /**
   * Moves the robot to its mechanical origin position
   * Must be performed immediately after power on
   */
  async nest(): Promise<void> {
    this.checkPortOpen();
    await this.sendCommandNoAnswer("NT");
  }

  /**
   * Resets the control box
   */
  async reset(): Promise<void> {
    this.checkPortOpen();
    await this.sendCommandNoAnswer("RS");
  }

  /**
   * Defines the pressure of the robot arm gripper
   * @param startingGripForce Starting gripping force (0-15)
   * @param retainedGrippingForce Retained gripping force (0-15)
   * @param startGrippingForceRetentionTime Start gripping force retention time (0-99)
   */
  async setGripPressure(
    startingGripForce: number,
    retainedGrippingForce: number,
    startGrippingForceRetentionTime: number
  ): Promise<void> {
    this.checkPortOpen();

    if (startingGripForce < 0 || startingGripForce > 15) {
      throw new Error("Starting grip force must be between 0 and 15");
    }
    if (retainedGrippingForce < 0 || retainedGrippingForce > 15) {
      throw new Error("Retained gripping force must be between 0 and 15");
    }
    if (
      startGrippingForceRetentionTime < 0 ||
      startGrippingForceRetentionTime > 99
    ) {
      throw new Error(
        "Start gripping force retention time must be between 0 and 99"
      );
    }

    await this.sendCommandNoAnswer(
      `GP ${startingGripForce}, ${retainedGrippingForce}, ${startGrippingForceRetentionTime}`
    );
  }

  /**
   * Rotates the axes relative to the actual position
   */
  async rotateAxis(
    x: number,
    y: number,
    z: number,
    p: number,
    r: number
  ): Promise<void> {
    this.checkPortOpen();

    await this.sendCommandNoAnswer(
      `MJ ${fmt(x)}, ${fmt(y)}, ${fmt(z)}, ${fmt(p)}, ${fmt(r)}`
    );

    // Update position from hardware after rotation
    await this.getActualPosition(true);
  }

  /**
   * Moves the robot arm to the given relative position/axis values
   * @param interpolatePoints when != 0: use linear calculated path points
   */
  async moveDelta(
    x: number,
    y: number,
    z: number,
    interpolatePoints?: number
  ): Promise<void>;
  async moveDelta(
    x: number,
    y: number,
    z: number,
    p: number,
    r: number,
    interpolatePoints?: number
  ): Promise<void>;
  async moveDelta(
    x: number,
    y: number,
    z: number,
    pOrInterpolatePoints?: number,
    r?: number,
    interpolatePoints?: number
  ): Promise<void> {
    if (!this.position) {
      throw new Error("Actual position not set");
    }

    // Handle overloads
    let p: number, actualInterpolatePoints: number;
    if (r === undefined && interpolatePoints === undefined) {
      // 3-parameter version: moveDelta(x, y, z, interpolatePoints?)
      p = this.position.p;
      r = this.position.r;
      actualInterpolatePoints = pOrInterpolatePoints ?? 0;
    } else {
      // 5-parameter version: moveDelta(x, y, z, p, r, interpolatePoints?)
      p = pOrInterpolatePoints ?? this.position.p;
      r = r ?? this.position.r;
      actualInterpolatePoints = interpolatePoints ?? 0;
    }

    return this.moveTo(
      {
        x: this.position.x + x,
        y: this.position.y + y,
        z: this.position.z + z,
        p: this.position.p + p,
        r: this.position.r + r,
      },
      actualInterpolatePoints
    );
  }

  /**
   * Utility function to clean up R value based on X and Y coordinates
   */
  cleanUpRValue(x: number, y: number, rTarget: number): number {
    return rTarget + (Math.atan2(x, y) * 180) / Math.PI;
  }

  /**
   * Gets if the tool gripper is closed
   */
  getGripperClosed(): boolean {
    return !this.toolIsOpen;
  }

  disconnect(): void {
    if (this.port) {
      this.port.close((err) => {
        if (err) {
          console.error("Error closing port:", err);
        } else {
          console.log("Port closed successfully.");
        }
      });
      this.port = null;
    } else {
      console.log("No port to close.");
    }
  }

  getPosition() {
    return this.position;
  }

  getToolLength() {
    return this.toolLength;
  }
  getSpeed() {
    return this.speed;
  }

  async listPorts(): Promise<string[]> {
    const ports = await SerialPort.list();
    return ports.map((port) => port.path);
  }
}

export default Robot;
