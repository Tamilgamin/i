/**
 * Incubator Monitor — Production Ready
 * Capacitor + MQTT + Background Alarm Support
 */

import { useEffect, useRef, useState } from "react";
import mqtt from "mqtt";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Capacitor } from "@capacitor/core";

// ✅ MQTT CONFIG
const MQTT_URL = "wss://57f9938c484c4f0f9ad4b79b70ae3bf7.s1.eu.hivemq.cloud:8884/mqtt";
const MQTT_OPTIONS = {
  username: "qqqqq",
  password: "Agash2008",
  reconnectPeriod: 5000,
};

// ✅ TEMP LIMITS
const LOW_TEMP = 25;
const HIGH_TEMP = 65;

export default function App() {
  const [temp, setTemp] = useState<number | null>(null);
  const [status, setStatus] = useState("DISCONNECTED");
  const [alarmActive, setAlarmActive] = useState(false);
  const clientRef = useRef<mqtt.MqttClient | null>(null);

  // 🔔 Request notification permission
  useEffect(() => {
    LocalNotifications.requestPermissions();
  }, []);

  // 🔌 MQTT CONNECT
  useEffect(() => {
    const client = mqtt.connect(MQTT_URL, MQTT_OPTIONS);
    clientRef.current = client;

    client.on("connect", () => {
      setStatus("CONNECTED");
      client.subscribe("incubator/temp");
    });

    client.on("message", (topic, message) => {
      const value = parseFloat(message.toString());
      if (!isNaN(value)) {
        setTemp(value);
        checkTemperature(value);
      }
    });

    client.on("reconnect", () => setStatus("RECONNECTING"));
    client.on("close", () => setStatus("DISCONNECTED"));
    client.on("error", () => setStatus("ERROR"));

    return () => client.end();
  }, []);

  // 🌡️ Temperature logic
  const checkTemperature = async (value: number) => {
    if (value < LOW_TEMP || value > HIGH_TEMP) {
      if (!alarmActive) {
        setAlarmActive(true);
        await triggerAlarm(value);
      }
    } else {
      setAlarmActive(false);
    }
  };

  // 🔔 Alarm + Notification
  const triggerAlarm = async (value: number) => {
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            title: "⚠️ Incubator Alert",
            body: `Temperature: ${value}°C`,
            id: Date.now(),
            schedule: { at: new Date(Date.now() + 100) },
          },
        ],
      });
    } catch (e) {
      console.log("Notification error:", e);
    }
  };

  // 🚀 Start foreground service (Android only)
  useEffect(() => {
    if (Capacitor.getPlatform() === "android") {
      // @ts-ignore
      if (window.cordova?.plugins?.foregroundService) {
        // @ts-ignore
        window.cordova.plugins.foregroundService.start("Incubator running");
      }
    }
  }, []);

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1>Incubator Monitor</h1>

      <h2>
        Temperature: {temp !== null ? `${temp.toFixed(2)} °C` : "--"}
      </h2>

      <p>Status: {status}</p>

      <p style={{ color: alarmActive ? "red" : "green" }}>
        {alarmActive ? "ALARM ACTIVE" : "Normal"}
      </p>
    </div>
  );
}
