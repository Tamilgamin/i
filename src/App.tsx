import React, { useEffect } from "react";
import { LocalNotifications } from "@capacitor/local-notifications";
import mqtt from "mqtt";

declare var cordova: any;

const MQTT_URL = "wss://broker.hivemq.com:8884/mqtt";
const TEMP_TOPIC = "incubator/temp";
const HIGH_TEMP = 38;

let client: any;

const App: React.FC = () => {
  useEffect(() => {
    initBackgroundServices();
    startMQTT();
  }, []);

  // ✅ Start foreground service & prevent sleep
  function initBackgroundServices() {
    if (window.cordova) {
      try {
        cordova.plugins.foregroundService.start(
          "Incubator monitoring running"
        );

        cordova.plugins.insomnia.keepAwake();

        console.log("✅ Background services started");
      } catch (err) {
        console.log("Foreground service error:", err);
      }
    }
  }

  // ✅ MQTT Connection
  function startMQTT() {
    client = mqtt.connect(MQTT_URL);

    client.on("connect", () => {
      console.log("✅ MQTT Connected");
      client.subscribe(TEMP_TOPIC);
    });

    client.on("message", (_, message) => {
      const temp = parseFloat(message.toString());
      console.log("Temperature:", temp);

      if (temp > HIGH_TEMP) {
        triggerAlarm(`Temperature too high: ${temp}°C`);
      }
    });

    client.on("close", () => {
      console.log("⚠ MQTT disconnected. Reconnecting...");
      setTimeout(startMQTT, 3000);
    });

    client.on("error", (err) => {
      console.log("MQTT error:", err);
    });
  }

  // ✅ Alarm + Notification
  async function triggerAlarm(message: string) {
    console.log("🚨 ALERT:", message);

    await LocalNotifications.schedule({
      notifications: [
        {
          id: Date.now(),
          title: "🚨 Incubator Alert",
          body: message,
          schedule: { at: new Date(Date.now() + 500) },
          sound: "beep.wav",
          smallIcon: "ic_stat_icon_config_sample",
        },
      ],
    });
  }

  return (
    <div style={{ textAlign: "center", marginTop: "40%" }}>
      <h2>🐣 Incubator Monitor</h2>
      <p>Running in background...</p>
    </div>
  );
};

export default App;