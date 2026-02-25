/**
 * Incubator Monitor — FULL FEATURE VERSION
 * UI + MQTT + Relay + Alarm + Capacitor Notifications + Background Safe
 */

import { useState, useEffect, useRef, useCallback, ChangeEvent } from "react";
import mqtt from "mqtt";
import {
  Thermometer,
  Settings as SettingsIcon,
  Bell,
  BellOff,
  Wifi,
  WifiOff,
  Volume2,
  Play,
  Clock,
  ChevronLeft,
  AlertCircle,
  Activity,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

// MQTT CONFIG
const MQTT_CONFIG = {
  host: "57f9938c484c4f0f9ad4b79b70ae3bf7.s1.eu.hivemq.cloud",
  port: 8884,
  username: "qqqqq",
  password: "Agash2008",
};

const TOPICS = {
  temp: "incubator/temp",
  relayState: "incubator/relaystate",
  relayControl: "incubator/relaycon",
};

type Status = "LOW" | "NORMAL" | "HIGH" | "DISCONNECTED";

interface AppSettings {
  alarmEnabled: boolean;
  alarmDuration: number;
  alarmDurationUnit: "seconds" | "minutes";
  customSoundUrl: string | null;
  lowTempThreshold: number;
  highTempThreshold: number;
}

// Native notification
async function notify(title: string, body: string) {
  if (!Capacitor.isNativePlatform()) return;
  await LocalNotifications.schedule({
    notifications: [{ title, body, id: Date.now() }],
  });
}

export default function App() {
  const [temp, setTemp] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("DISCONNECTED");
  const [relayState, setRelayState] = useState<"ON" | "OFF">("OFF");
  const [isConnected, setIsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<"home" | "settings">("home");
  const [isAlarmActive, setIsAlarmActive] = useState(false);

  const [settings, setSettings] = useState<AppSettings>({
    alarmEnabled: true,
    alarmDuration: 30,
    alarmDurationUnit: "seconds",
    customSoundUrl: null,
    lowTempThreshold: 25,
    highTempThreshold: 38,
  });

  const mqttClient = useRef<mqtt.MqttClient | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const alarmTimer = useRef<NodeJS.Timeout | null>(null);

  // 🔔 Request notification permission
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      LocalNotifications.requestPermissions();
    }
  }, []);

  // 🚀 Foreground service (keeps app alive)
  useEffect(() => {
    if (Capacitor.getPlatform() === "android") {
      // @ts-ignore
      window.cordova?.plugins?.foregroundService?.start(
        "Incubator monitoring running"
      );
    }
  }, []);

  // 🔌 MQTT CONNECTION
  useEffect(() => {
    const client = mqtt.connect(
      `wss://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}/mqtt`,
      {
        username: MQTT_CONFIG.username,
        password: MQTT_CONFIG.password,
        reconnectPeriod: 5000,
      }
    );

    mqttClient.current = client;

    client.on("connect", () => {
      setIsConnected(true);
      client.subscribe([TOPICS.temp, TOPICS.relayState]);
    });

    client.on("message", (topic, msg) => {
      const payload = msg.toString();

      if (topic === TOPICS.temp) {
        const value = parseFloat(payload);
        if (!isNaN(value)) {
          setTemp(value);

          if (value < settings.lowTempThreshold) setStatus("LOW");
          else if (value > settings.highTempThreshold) setStatus("HIGH");
          else setStatus("NORMAL");
        }
      }

      if (topic === TOPICS.relayState) {
        setRelayState(payload === "ON" ? "ON" : "OFF");
      }
    });

    client.on("close", () => {
      setIsConnected(false);
      setStatus("DISCONNECTED");
    });

    return () => client.end();
  }, []);

  // 🔔 ALARM LOGIC
  const stopAlarm = useCallback(() => {
    setIsAlarmActive(false);
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (alarmTimer.current) clearTimeout(alarmTimer.current);
  }, []);

  const triggerAlarm = useCallback(async () => {
    if (!settings.alarmEnabled || isAlarmActive) return;

    setIsAlarmActive(true);
    audioRef.current?.play().catch(() => {});

    await notify("🚨 Incubator Alert", `Temperature ${temp}°C (${status})`);

    const duration =
      settings.alarmDurationUnit === "minutes"
        ? settings.alarmDuration * 60000
        : settings.alarmDuration * 1000;

    alarmTimer.current = setTimeout(stopAlarm, duration);
  }, [settings, isAlarmActive, temp, status, stopAlarm]);

  useEffect(() => {
    if (temp === null) return;
    if (
      temp < settings.lowTempThreshold ||
      temp > settings.highTempThreshold
    ) {
      triggerAlarm();
    }
  }, [temp]);

  // 🔌 RELAY TOGGLE
  const toggleRelay = () => {
    if (!mqttClient.current?.connected) return;
    const newState = relayState === "ON" ? "OFF" : "ON";
    mqttClient.current.publish(TOPICS.relayControl, newState);
  };

  // 🔊 SOUND UPLOAD
  const handleSoundUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSettings((s) => ({ ...s, customSoundUrl: URL.createObjectURL(file) }));
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <audio
        ref={audioRef}
        src={
          settings.customSoundUrl ||
          "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"
        }
        loop
      />

      {/* HEADER */}
      <header className="p-6 flex justify-between border-b border-zinc-800">
        <div className="flex items-center space-x-3">
          {isConnected ? (
            <Wifi className="text-emerald-500" />
          ) : (
            <WifiOff className="text-red-500" />
          )}
          <div>
            <h1 className="font-bold">Incubator</h1>
            <p className="text-xs">{status}</p>
          </div>
        </div>
        <button onClick={() => setActiveTab(activeTab === "home" ? "settings" : "home")}>
          {activeTab === "home" ? <SettingsIcon /> : <ChevronLeft />}
        </button>
      </header>

      {/* MAIN */}
      <main className="p-6 space-y-6">
        <h2 className="text-5xl font-light">
          {temp !== null ? temp.toFixed(1) : "--"}°C
        </h2>

        {/* RELAY */}
        <div className="flex justify-between bg-zinc-900 p-4 rounded-xl">
          <span>Relay</span>
          <button
            onClick={toggleRelay}
            className={`px-4 py-2 rounded-lg ${
              relayState === "ON" ? "bg-emerald-500" : "bg-zinc-700"
            }`}
          >
            {relayState}
          </button>
        </div>

        {/* ALARM */}
        {isAlarmActive && (
          <div className="bg-red-500 p-4 rounded-xl flex justify-between">
            <span>ALARM ACTIVE</span>
            <button onClick={stopAlarm}>Mute</button>
          </div>
        )}

        {/* SETTINGS TAB */}
        {activeTab === "settings" && (
          <div className="space-y-4">
            <label>Low Temp</label>
            <input
              type="number"
              value={settings.lowTempThreshold}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  lowTempThreshold: parseFloat(e.target.value),
                }))
              }
            />

            <label>High Temp</label>
            <input
              type="number"
              value={settings.highTempThreshold}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  highTempThreshold: parseFloat(e.target.value),
                }))
              }
            />

            <input type="file" accept="audio/*" onChange={handleSoundUpload} />
          </div>
        )}
      </main>
    </div>
  );
}
