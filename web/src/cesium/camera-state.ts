import { Cartesian3, Math as CesiumMath, type Camera } from "cesium";
import { isValidCameraState, type CameraState } from "../view-state.ts";

export function captureCameraState(camera: Camera): CameraState | null {
  const position = camera.positionCartographic;
  const values = [
    position.longitude,
    position.latitude,
    position.height,
    camera.heading,
    camera.pitch,
    camera.roll,
  ];
  if (!values.every(Number.isFinite)) {
    return null;
  }

  const state: CameraState = {
    destination: {
      height: position.height,
      latitudeDegrees: CesiumMath.toDegrees(position.latitude),
      longitudeDegrees: CesiumMath.toDegrees(position.longitude),
    },
    orientation: {
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    },
  };
  return isValidCameraState(state) ? state : null;
}

export function restoreCameraState(camera: Camera, state: CameraState): void {
  camera.setView({
    destination: Cartesian3.fromDegrees(
      state.destination.longitudeDegrees,
      state.destination.latitudeDegrees,
      state.destination.height,
    ),
    orientation: { ...state.orientation },
  });
}
