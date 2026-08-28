import "../chat/test/localStorage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FIT_CALIBRATION_STORAGE_KEY,
  calibrationFactorFor,
  loadFitCalibration,
  recordFitObservation,
  saveFitCalibration,
} from "./fitCalibration";

beforeEach(() => {
  window.localStorage.clear();
});

describe("fitCalibration persistence", () => {
  it("starts empty with nothing stored", () => {
    expect(loadFitCalibration()).toEqual({});
    expect(calibrationFactorFor("llama3.1:8b")).toBeNull();
  });

  it("degrades to empty on corrupt JSON rather than throwing", () => {
    window.localStorage.setItem(FIT_CALIBRATION_STORAGE_KEY, "{not json");
    expect(loadFitCalibration()).toEqual({});
  });

  it("drops a non-object payload", () => {
    window.localStorage.setItem(FIT_CALIBRATION_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadFitCalibration()).toEqual({});
  });

  it("keeps a well-formed entry and drops a malformed sibling", () => {
    window.localStorage.setItem(
      FIT_CALIBRATION_STORAGE_KEY,
      JSON.stringify({ "llama3.1:8b": 1.1, "broken:tag": "not a number", "": 1.2 }),
    );
    expect(loadFitCalibration()).toEqual({ "llama3.1:8b": 1.1 });
  });

  it("round-trips through save/load", () => {
    saveFitCalibration({ "llama3.1:8b": 0.9 });
    expect(loadFitCalibration()).toEqual({ "llama3.1:8b": 0.9 });
    expect(calibrationFactorFor("llama3.1:8b")).toBe(0.9);
  });
});

describe("recordFitObservation", () => {
  it("stores actual / predicted for the tag", () => {
    recordFitObservation("llama3.1:8b", 5_000_000_000, 5_500_000_000);
    expect(calibrationFactorFor("llama3.1:8b")).toBe(1.1);
  });

  it("overwrites a prior observation for the same tag", () => {
    recordFitObservation("llama3.1:8b", 5_000_000_000, 5_500_000_000);
    recordFitObservation("llama3.1:8b", 5_000_000_000, 6_000_000_000);
    expect(calibrationFactorFor("llama3.1:8b")).toBe(1.2);
  });

  it("ignores a zero predicted value", () => {
    recordFitObservation("llama3.1:8b", 0, 5_000_000_000);
    expect(calibrationFactorFor("llama3.1:8b")).toBeNull();
  });

  it("ignores a negative actual value", () => {
    recordFitObservation("llama3.1:8b", 5_000_000_000, -1);
    expect(calibrationFactorFor("llama3.1:8b")).toBeNull();
  });

  it("rejects a ratio outside the sane band and keeps the tag uncalibrated", () => {
    // 5x the prediction — a bad reading, not a real correction.
    recordFitObservation("llama3.1:8b", 1_000_000_000, 5_000_000_000);
    expect(calibrationFactorFor("llama3.1:8b")).toBeNull();
  });

  it("rejects a ratio just outside each edge of the band", () => {
    recordFitObservation("a", 1_000_000_000, 90_000_000); // 0.09 < 0.1
    recordFitObservation("b", 1_000_000_000, 4_010_000_000); // 4.01 > 4.0
    expect(calibrationFactorFor("a")).toBeNull();
    expect(calibrationFactorFor("b")).toBeNull();
  });

  it("accepts a ratio right at each edge of the band", () => {
    recordFitObservation("a", 1_000_000_000, 100_000_000); // exactly 0.1
    recordFitObservation("b", 1_000_000_000, 4_000_000_000); // exactly 4.0
    expect(calibrationFactorFor("a")).toBe(0.1);
    expect(calibrationFactorFor("b")).toBe(4);
  });

  it("keeps calibration for other tags independent", () => {
    recordFitObservation("a", 1_000_000_000, 1_100_000_000);
    recordFitObservation("b", 1_000_000_000, 900_000_000);
    expect(calibrationFactorFor("a")).toBe(1.1);
    expect(calibrationFactorFor("b")).toBe(0.9);
  });
});
