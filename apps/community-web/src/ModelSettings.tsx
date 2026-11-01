import { Button } from "@workspace/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, post } from "./api";
import {
  type DisplayModel,
  hasUnsavedModelChanges,
  setSettingsWritePending,
  settingsFailure,
  settingsWritePending,
} from "./model-settings";
import { withRequestTimeout } from "./models/model-session";

export function ModelSettings({ onBack }: { onBack: () => void }) {
  const [config, setConfig] = useState<DisplayModel | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [uncertain, setUncertain] = useState(settingsWritePending);
  const uncertainRef = useRef(uncertain);
  const [rechecked, setRechecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const dirty = hasUnsavedModelChanges(config, baseUrl, model, apiKey);

  function markUncertain(value: boolean) {
    uncertainRef.current = value;
    setSettingsWritePending(value);
    setUncertain(value);
    if (!value) setRechecked(false);
  }

  const load = useCallback(async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setStatus("");
    if (uncertainRef.current) setRechecked(false);
    try {
      const value = await withRequestTimeout(controller.signal, 8_000, (signal) =>
        api<DisplayModel>("/api/model/config", { signal }),
      );
      if (!mounted.current || active.current !== controller) return;
      setConfig(value);
      setBaseUrl(value.configured ? value.baseUrl : "");
      setModel(value.configured ? value.model : "");
      setApiKey("");
      if (uncertainRef.current) {
        setRechecked(true);
        setStatus(
          "当前显示的是读取时的配置；先前操作可能仍在处理，请稍后再次核对。确认后可继续操作。",
        );
      }
    } catch (error) {
      if (!mounted.current || active.current !== controller) return;
      setConfig(null);
      setStatus(settingsFailure("load", error, controller.signal.aborted).message);
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
    };
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (active.current || !config || uncertain) return;
    const controller = new AbortController();
    active.current = controller;
    markUncertain(true);
    setRechecked(false);
    setBusy(true);
    setStatus("");
    try {
      const value = await withRequestTimeout(controller.signal, 10_000, (signal) =>
        api<DisplayModel>("/api/model/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, model, apiKey }),
          signal,
        }),
      );
      if (!mounted.current || active.current !== controller) return;
      setConfig(value);
      if (value.configured) {
        setBaseUrl(value.baseUrl);
        setModel(value.model);
      }
      setApiKey("");
      markUncertain(false);
      setStatus("配置已保存到平台所在电脑的系统凭据库。");
    } catch (error) {
      if (!mounted.current || active.current !== controller) return;
      const failure = settingsFailure("save", error, controller.signal.aborted);
      markUncertain(failure.uncertain);
      setStatus(failure.message);
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  async function check() {
    if (active.current || !config?.configured || dirty || uncertain) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setChecking(true);
    setStatus("正在使用示例信息检查模型连接…");
    try {
      await withRequestTimeout(controller.signal, 40_000, (signal) =>
        api("/api/model/check", { ...post({ configVersion: config.configVersion }), signal }),
      );
      if (!mounted.current || active.current !== controller) return;
      setStatus("模型接口连接成功。");
    } catch (error) {
      if (!mounted.current || active.current !== controller) return;
      if (error instanceof ApiError && error.status === 409) setConfig(null);
      setStatus(settingsFailure("check", error, controller.signal.aborted).message);
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) {
          setBusy(false);
          setChecking(false);
        }
      }
    }
  }

  async function clear() {
    if (active.current || !config?.configured || uncertain) return;
    const controller = new AbortController();
    active.current = controller;
    markUncertain(true);
    setRechecked(false);
    setBusy(true);
    setStatus("");
    try {
      await withRequestTimeout(controller.signal, 10_000, (signal) =>
        api("/api/model/config", { method: "DELETE", signal }),
      );
      if (!mounted.current || active.current !== controller) return;
      setConfig({ configured: false });
      setBaseUrl("");
      setModel("");
      setApiKey("");
      markUncertain(false);
      setStatus("已移除模型配置。");
    } catch (error) {
      if (!mounted.current || active.current !== controller) return;
      const failure = settingsFailure("remove", error, controller.signal.aborted);
      markUncertain(failure.uncertain);
      setStatus(failure.message);
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  return (
    <main className="settings-page">
      <Button type="button" onClick={onBack}>
        返回工作空间
      </Button>
      <div className="product-eyebrow">MODEL SETTINGS</div>
      <h1>模型配置</h1>
      <p>使用你自己的 OpenAI 兼容接口。密钥只保存在运行平台服务的电脑，不会再次显示。</p>
      <section className="settings-card">
        <h2>连接设置</h2>
        <p>
          {loading
            ? "正在读取配置…"
            : uncertain
              ? "配置状态未确认"
              : config === null
                ? "请重新读取配置"
                : config.configured
                  ? "已配置密钥"
                  : "尚未配置模型"}
        </p>
        <form className="product-form" onSubmit={(event) => void save(event)}>
          <label>
            接口地址
            <input
              required
              disabled={busy || loading || uncertain || config === null}
              type="url"
              value={baseUrl}
              onChange={(event) => {
                setStatus("");
                setBaseUrl(event.target.value);
              }}
              placeholder="https://provider.example/v1"
            />
          </label>
          <label>
            模型名称
            <input
              required
              disabled={busy || loading || uncertain || config === null}
              value={model}
              maxLength={256}
              onChange={(event) => {
                setStatus("");
                setModel(event.target.value);
              }}
              placeholder="填写供应商提供的模型名称"
            />
          </label>
          <label>
            访问密钥
            <input
              required
              disabled={busy || loading || uncertain || config === null}
              type="password"
              autoComplete="off"
              value={apiKey}
              maxLength={4096}
              onChange={(event) => {
                setStatus("");
                setApiKey(event.target.value);
              }}
              placeholder={config?.configured ? "修改配置时请重新输入密钥" : "输入模型访问密钥"}
            />
          </label>
          <p>
            外部接口使用公网 HTTPS；本机模型服务可使用本机
            HTTP。检查连接会发送一条示例请求，不包含你的数据库信息。
          </p>
          <div className="read-query-actions">
            <Button
              className="product-primary"
              disabled={busy || loading || uncertain || config === null}
              type="submit"
            >
              保存配置
            </Button>
            <Button
              disabled={busy || loading || uncertain || !config?.configured || dirty}
              type="button"
              onClick={() => void check()}
            >
              检查连接
            </Button>
            <Button
              disabled={busy || loading || uncertain || !config?.configured}
              type="button"
              onClick={() => void clear()}
            >
              移除配置
            </Button>
          </div>
          {dirty && !uncertain && <p>配置有未保存的更改，请先保存后再检查连接。</p>}
        </form>
        {checking && (
          <Button type="button" onClick={() => active.current?.abort()}>
            取消检查
          </Button>
        )}
        {(uncertain || (config === null && !loading)) && (
          <Button type="button" disabled={busy || loading} onClick={() => void load()}>
            重新读取配置
          </Button>
        )}
        {uncertain && rechecked && !loading && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              markUncertain(false);
              setStatus("已继续操作；先前请求仍可能稍后完成，请留意配置变化。");
            }}
          >
            已核对，继续操作
          </Button>
        )}
        {status && <p role="status">{status}</p>}
      </section>
    </main>
  );
}
