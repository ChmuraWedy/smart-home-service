#include <Arduino.h>
#if __has_include("panel_config.h")
#include "panel_config.h"
#else
#include "config.example.h"
#endif
#include "board.hpp"
#include "panel_model.hpp"
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <lvgl.h>

extern "C" const lv_font_t panel_font;
static PanelDriver screen;
static panel::Model model;
static Preferences prefs;
static String panelId;
static DynamicJsonDocument snapshot(32768), pageData(24576);
static lv_color_t pixels[480 * 12];
static lv_disp_draw_buf_t drawBuffer;
static lv_obj_t *body, *message;
static uint32_t lastGood = 0, nextRead = 0, generation = 0;
static bool busy = false, configured = false, requestRefresh = false, commandAllowed = false;
static int pageOffset = 0;
static String colorCapability;

enum class RequestKind { Config, Rooms, Options, Save, Dashboard, Refresh, Command };
struct Job { RequestKind kind; String method, path, payload; uint32_t generation; };
struct Result { RequestKind kind; int status; String body; uint32_t generation; };
static QueueHandle_t jobs, replies;

// Bound even unknown-length/chunked HTTP responses before allocating a JSON document.
class BoundedBody : public Stream {
public:
    String text;
    bool exceeded = false;
    BoundedBody() { text.reserve(2048); }
    size_t write(uint8_t value) override { return write(&value, 1); }
    size_t write(const uint8_t *data, size_t length) override {
        if (text.length() + length > 32768) { exceeded = true; return 0; }
        return text.concat(reinterpret_cast<const char *>(data), length) ? length : 0;
    }
    int available() override { return 0; }
    int read() override { return -1; }
    int peek() override { return -1; }
    void flush() override {}
};

static void networkTask(void *) {
    for (;;) {
        Job *job = nullptr;
        if (xQueueReceive(jobs, &job, portMAX_DELAY) != pdTRUE) continue;
        Result *result = new Result{job->kind, -1, "", job->generation};
        if (WiFi.status() == WL_CONNECTED) {
            WiFiClient client;
            HTTPClient http;
            http.setConnectTimeout(3000);
            http.setTimeout(7000);
            // This firmware profile uses an HTTP endpoint on the trusted local LAN.
            if (http.begin(client, String(API_BASE) + job->path)) {
                http.addHeader("X-API-Key", API_TOKEN);
                http.addHeader("Content-Type", "application/json");
                result->status = http.sendRequest(job->method.c_str(), job->payload);
                if (result->status > 0) {
                    BoundedBody sink;
                    int written = http.writeToStream(&sink);
                    if (sink.exceeded || written < 0) result->status = -2;
                    else result->body = std::move(sink.text);
                }
                http.end();
            }
        }
        delete job;
        // Only one job is in flight; the UI owns/deletes the response after dequeueing.
        xQueueSend(replies, &result, portMAX_DELAY);
    }
}

static bool send(RequestKind kind, const String &method, const String &path, const String &payload = "") {
    if (busy) return false;
    Job *job = new Job{kind, method, path, payload, generation};
    if (xQueueSend(jobs, &job, 0) != pdTRUE) { delete job; return false; }
    busy = true;
    return true;
}
static String displayPath(const String &suffix = "") { return "/displays/" + panelId + suffix; }
static bool connected() { return WiFi.status() == WL_CONNECTED && lastGood && millis() - lastGood < 25000; }
static void notice(const char *text) { if (message) lv_label_set_text(message, text); }
static void render();
static void loadPage();

enum class ActionKind { Back, Setup, Room, Toggle, Save, Next, Previous, Group, Device, Boolean, Numeric, Enum, Color, ApplyColor };
struct Action {
    ActionKind kind;
    panel::Target target;
    String capability;
    lv_obj_t *input = nullptr, *secondary = nullptr, *tertiary = nullptr, *valueLabel = nullptr;
    double minimum = 0, maximum = 100, step = 1;
    bool boolean = false;
};
static Action actions[64];
static size_t actionCount;
struct ReadingLabel { String capability; lv_obj_t *object; };
static ReadingLabel readingLabels[8];
static size_t readingCount = 0;
static void clicked(lv_event_t *event);
static Action *action(ActionKind kind, panel::Target target = {}) {
    if (actionCount >= 64) return nullptr;
    Action *item = &actions[actionCount++];
    *item = Action(); item->kind = kind; item->target = target;
    return item;
}
static lv_obj_t *label(lv_obj_t *parent, const String &text) {
    lv_obj_t *item = lv_label_create(parent);
    lv_label_set_text(item, text.c_str());
    lv_obj_set_width(item, LV_PCT(100));
    lv_label_set_long_mode(item, LV_LABEL_LONG_WRAP);
    return item;
}
static lv_obj_t *button(lv_obj_t *parent, const String &text, Action *item, bool enabled = true) {
    lv_obj_t *result = lv_btn_create(parent);
    lv_obj_set_width(result, LV_PCT(100)); lv_obj_set_height(result, LV_SIZE_CONTENT);
    label(result, text);
    if (item) lv_obj_add_event_cb(result, clicked, LV_EVENT_CLICKED, item);
    if (!enabled || !item) lv_obj_add_state(result, LV_STATE_DISABLED);
    return result;
}
static lv_obj_t *section() {
    lv_obj_t *item = lv_obj_create(body);
    lv_obj_set_width(item, LV_PCT(100)); lv_obj_set_height(item, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(item, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(item, 8, 0);
    return item;
}
static JsonObject device(uint32_t id) {
    for (JsonObject widget : snapshot["widgets"].as<JsonArray>()) {
        if (widget["kind"] == "device" && widget["id"].as<uint32_t>() == id) return widget;
        if (widget["kind"] == "group")
            for (JsonObject member : widget["members"].as<JsonArray>())
                if (member["id"].as<uint32_t>() == id) return member;
    }
    return JsonObject();
}
static JsonObject group(uint32_t id) {
    for (JsonObject item : snapshot["widgets"].as<JsonArray>())
        if (item["kind"] == "group" && item["id"].as<uint32_t>() == id) return item;
    return JsonObject();
}
static bool fresh(JsonObject card, JsonObject reading) {
    return card["enabled"].as<bool>() && panel::fresh(reading["known"] | false, reading["stale"] | true, connected());
}
static String caption(const String &name) {
    if (name == "switch") return "Питание";
    if (name == "brightness") return "Яркость";
    if (name == "color_temperature") return "Температура света";
    if (name == "temperature") return "Температура";
    if (name == "target_temperature") return "Заданная температура";
    if (name == "humidity") return "Влажность";
    if (name == "motion" || name == "presence") return "Движение";
    if (name == "color") return "Цвет";
    if (name == "position") return "Положение";
    if (name == "speed") return "Скорость";
    return name;
}
static String readingText(JsonObject card, const char *name) {
    JsonObject reading = card["values"][name];
    if (!fresh(card, reading)) return "нет актуальных данных";
    JsonVariant value = reading["value"];
    if (value.is<bool>()) {
        bool yes = value.as<bool>();
        if (String(name) == "motion" || String(name) == "presence") return yes ? "есть движение" : "нет движения";
        return yes ? "вкл" : "выкл";
    }
    if (value.is<JsonObject>()) return "цвет задан";
    String text; serializeJson(value, text);
    if (value.is<const char *>()) text = value.as<const char *>();
    String unit = card["capabilities"][name]["unit"] | "";
    return text + (unit.length() ? " " + unit : "");
}
static String deviceSummary(JsonObject card) {
    String text = card["name"] | "Устройство";
    for (JsonPair pair : card["values"].as<JsonObject>()) {
        String key = pair.key().c_str();
        if (key == "switch" || key == "temperature" || key == "humidity" || key == "motion" || key == "presence")
            text += "\n" + caption(key) + ": " + readingText(card, pair.key().c_str());
    }
    return text;
}
static String groupSummary(JsonObject item) {
    String state = connected() ? String(item["state"] | "unknown") : "unknown";
    String text = item["name"] | "Группа ламп";
    if (state == "on") return text + "\nВсе включены";
    if (state == "off") return text + "\nВсе выключены";
    if (state == "mixed") return text + "\nВключена часть ламп";
    return text + "\nНет актуальных данных";
}
static void slidersChanged(lv_event_t *event) {
    Action *item = static_cast<Action *>(lv_event_get_user_data(event));
    if (!item || !item->valueLabel) return;
    double value = panel::numericValue(lv_slider_get_value(item->input), item->minimum, item->maximum, item->step);
    lv_label_set_text_fmt(item->valueLabel, "%.2f", value);
}
static void slider(lv_obj_t *parent, Action *item, double value) {
    item->input = lv_slider_create(parent);
    lv_obj_set_width(item->input, LV_PCT(88));
    lv_slider_set_range(item->input, 0, 1000);
    int tick = item->maximum > item->minimum ? lround((value - item->minimum) * 1000 / (item->maximum - item->minimum)) : 0;
    lv_slider_set_value(item->input, constrain(tick, 0, 1000), LV_ANIM_OFF);
    item->valueLabel = label(parent, String(value, 2));
    lv_obj_add_event_cb(item->input, slidersChanged, LV_EVENT_VALUE_CHANGED, item);
}
static void renderControls(JsonObject card) {
    if (card.isNull()) { label(body, "Устройство отсутствует в выбранной комнате"); return; }
    label(body, card["name"] | "Устройство");
    bool writable = connected() && card["enabled"].as<bool>();
    for (JsonPair entry : card["capabilities"].as<JsonObject>()) {
        String name = entry.key().c_str(); JsonObject spec = entry.value();
        lv_obj_t *box = section();
        lv_obj_t *current = label(box, caption(name) + ": " + readingText(card, name.c_str()));
        if (readingCount < 8) readingLabels[readingCount++] = {name, current};
        if (!(spec["writable"] | true)) continue;
        String type = spec["type"] | "";
        if (type == "boolean") {
            Action *on = action(ActionKind::Boolean, {model.activeDevice, false});
            on->capability = name; on->boolean = true;
            button(box, "Включить", on, writable);
            Action *off = action(ActionKind::Boolean, {model.activeDevice, false});
            off->capability = name; off->boolean = false;
            button(box, "Выключить", off, writable);
        } else if (type == "integer" || type == "number") {
            if (spec["minimum"].isNull() || spec["maximum"].isNull()) {
                label(box, "Для регулировки задайте диапазон на сервере"); continue;
            }
            Action *set = action(ActionKind::Numeric, {model.activeDevice, false});
            set->capability = name; set->minimum = spec["minimum"]; set->maximum = spec["maximum"];
            set->step = spec["step"] | (type == "integer" ? 1.0 : 0.0);
            double value = fresh(card, card["values"][name]) ? card["values"][name]["value"].as<double>() : set->minimum;
            slider(box, set, value);
            button(box, "Применить", set, writable);
        } else if (spec["enum"].is<JsonArray>()) {
            String choices;
            for (JsonVariant option : spec["enum"].as<JsonArray>()) {
                String value;
                if (option.is<const char *>()) value = option.as<const char *>();
                else serializeJson(option, value);
                value.replace("\n", " ");
                if (choices.length()) choices += "\n";
                choices += value;
            }
            if (!choices.length()) continue;
            Action *set = action(ActionKind::Enum, {model.activeDevice, false}); set->capability = name;
            set->input = lv_dropdown_create(box); lv_obj_set_width(set->input, LV_PCT(100));
            lv_dropdown_set_options(set->input, choices.c_str());
            // The explicit Apply button makes a new value a user command, never an implicit write.
            button(box, "Применить", set, writable);
        } else if (name == "color") {
            Action *choose = action(ActionKind::Color, {model.activeDevice, false}); choose->capability = name;
            button(box, "Выбрать цвет", choose, writable);
        }
    }
}
static void renderColor() {
    label(body, "Цвет лампы");
    Action *set = action(ActionKind::ApplyColor, {model.activeDevice, false}); set->capability = colorCapability;
    set->input = lv_colorwheel_create(body, true);
    lv_obj_set_size(set->input, 145, 145);
    lv_colorwheel_set_mode(set->input, LV_COLORWHEEL_MODE_HUE);
    lv_colorwheel_set_mode_fixed(set->input, true);
    JsonObject card = device(model.activeDevice), reading = card["values"][colorCapability];
    lv_color_hsv_t hsv{0, 100, 100};
    if (fresh(card, reading)) {
        hsv.h = reading["value"]["h"] | 0;
        hsv.s = (reading["value"]["s"] | 1000) / 10;
        hsv.v = (reading["value"]["v"] | 1000) / 10;
    }
    lv_colorwheel_set_hsv(set->input, hsv);
    label(body, "Насыщенность");
    set->secondary = lv_slider_create(body); lv_obj_set_width(set->secondary, LV_PCT(88));
    lv_slider_set_range(set->secondary, 0, 1000); lv_slider_set_value(set->secondary, hsv.s * 10, LV_ANIM_OFF);
    label(body, "Яркость цвета");
    set->tertiary = lv_slider_create(body); lv_obj_set_width(set->tertiary, LV_PCT(88));
    lv_slider_set_range(set->tertiary, 0, 1000); lv_slider_set_value(set->tertiary, hsv.v * 10, LV_ANIM_OFF);
    button(body, "Применить цвет", set, connected() && card["enabled"].as<bool>());
}
static void render() {
    // LVGL objects are touched exclusively by the UI task.
    lv_obj_clean(lv_scr_act()); actionCount = 0; readingCount = 0;
    lv_obj_set_flex_flow(lv_scr_act(), LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(lv_scr_act(), 6, 0);
    lv_obj_set_style_pad_row(lv_scr_act(), 4, 0);
    lv_obj_t *header = lv_obj_create(lv_scr_act());
    lv_obj_set_width(header, LV_PCT(100)); lv_obj_set_height(header, 38);
    lv_obj_set_style_pad_all(header, 2, 0); lv_obj_set_flex_flow(header, LV_FLEX_FLOW_ROW);
    lv_obj_t *back = button(header, "Назад", action(ActionKind::Back)); lv_obj_set_width(back, 85);
    lv_obj_t *setup = button(header, "Комната / выбор", action(ActionKind::Setup)); lv_obj_set_flex_grow(setup, 1);
    message = lv_label_create(lv_scr_act()); lv_obj_set_width(message, LV_PCT(100));
    lv_label_set_long_mode(message, LV_LABEL_LONG_WRAP);
    notice(connected() ? "Сервер подключён" : "Нет связи. Статус неизвестен");
    body = lv_obj_create(lv_scr_act()); lv_obj_set_width(body, LV_PCT(100)); lv_obj_set_flex_grow(body, 1);
    lv_obj_set_flex_flow(body, LV_FLEX_FLOW_COLUMN); lv_obj_set_style_pad_all(body, 4, 0);
    if (model.page == panel::Page::Dashboard) {
        label(body, snapshot["room_name"] | "Выберите комнату");
        for (JsonObject item : snapshot["widgets"].as<JsonArray>()) {
            bool isGroup = item["kind"] == "group";
            button(body, isGroup ? groupSummary(item) : deviceSummary(item),
                action(isGroup ? ActionKind::Group : ActionKind::Device, {item["id"].as<uint32_t>(), isGroup}));
        }
        if (!configured) button(body, "Настроить экран", action(ActionKind::Setup));
    } else if (model.page == panel::Page::Rooms) {
        label(body, "Выберите комнату");
        for (JsonObject room : pageData["rooms"].as<JsonArray>())
            button(body, String(room["building_name"] | "") + " / " + (room["name"] | ""),
                action(ActionKind::Room, {room["id"].as<uint32_t>(), false}));
        if (pageOffset > 0) button(body, "Предыдущие", action(ActionKind::Previous));
        if (pageData["more"] | false) button(body, "Следующие", action(ActionKind::Next));
    } else if (model.page == panel::Page::Selection) {
        label(body, "Выберите плитки: " + String(model.count) + "/12");
        for (const char *collection : {"groups", "devices"})
            for (JsonObject item : pageData[collection].as<JsonArray>()) {
                bool isGroup = String(collection) == "groups";
                panel::Target target(item["id"].as<uint32_t>(), isGroup);
                lv_obj_t *checkbox = lv_checkbox_create(body);
                lv_obj_set_width(checkbox, LV_PCT(100));
                String text = String(isGroup ? "Группа: " : "") + (item["name"] | "");
                lv_checkbox_set_text(checkbox, text.c_str());
                if (model.contains(target)) lv_obj_add_state(checkbox, LV_STATE_CHECKED);
                lv_obj_add_event_cb(checkbox, clicked, LV_EVENT_VALUE_CHANGED, action(ActionKind::Toggle, target));
            }
        button(body, "Сохранить выбор", action(ActionKind::Save), connected());
        if (pageOffset > 0) button(body, "Предыдущие", action(ActionKind::Previous));
        if ((pageData["more_devices"] | false) || (pageData["more_groups"] | false)) button(body, "Следующие", action(ActionKind::Next));
    } else if (model.page == panel::Page::Group) {
        JsonObject item = group(model.activeGroup);
        label(body, groupSummary(item));
        Action *on = action(ActionKind::Boolean, {model.activeGroup, true}); on->boolean = true;
        Action *off = action(ActionKind::Boolean, {model.activeGroup, true}); off->boolean = false;
        button(body, "Все включить", on, connected()); button(body, "Все выключить", off, connected());
        for (JsonObject member : item["members"].as<JsonArray>())
            button(body, deviceSummary(member), action(ActionKind::Device, {member["id"].as<uint32_t>(), false}));
    } else if (model.page == panel::Page::Device) renderControls(device(model.activeDevice));
    else if (model.page == panel::Page::Color) renderColor();
}

static void loadPage() {
    pageData.clear(); ++generation; render();
    String query = "?offset=" + String(pageOffset) + "&limit=8";
    if (model.page == panel::Page::Rooms) send(RequestKind::Rooms, "GET", displayPath("/rooms") + query);
    else if (model.page == panel::Page::Selection)
        send(RequestKind::Options, "GET", displayPath("/options") + query + "&room_id=" + String(model.room));
    else if (configured) send(RequestKind::Dashboard, "GET", displayPath("/dashboard"));
}
static void command(Action *item, JsonVariant value) {
    if (!connected() || busy || !commandAllowed) { notice("Дождитесь связи с сервером"); return; }
    if (item->target.group) {
        send(RequestKind::Command, "POST", "/groups/" + String(item->target.id) + "/commands/" + (item->boolean ? "on" : "off"));
    } else {
        DynamicJsonDocument request(1024); request["values"][item->capability] = value;
        String payload; serializeJson(request, payload);
        send(RequestKind::Command, "POST", "/devices/" + String(item->target.id) + "/commands/capabilities", payload);
    }
    notice("Отправка команды…");
}
static void clicked(lv_event_t *event) {
    Action *item = static_cast<Action *>(lv_event_get_user_data(event));
    if (!item) return;
    // During a write, do not replace the configuration or enqueue another command.
    if (busy) {
        if (item->kind == ActionKind::Toggle) {
            if (model.contains(item->target)) lv_obj_add_state(lv_event_get_target(event), LV_STATE_CHECKED);
            else lv_obj_clear_state(lv_event_get_target(event), LV_STATE_CHECKED);
        }
        notice("Дождитесь ответа сервера"); return;
    }
    DynamicJsonDocument value(1024);
    switch (item->kind) {
    case ActionKind::Setup:
        model.page = panel::Page::Rooms; pageOffset = 0; loadPage(); break;
    case ActionKind::Back:
        model.back(); pageOffset = 0;
        if (model.page == panel::Page::Rooms) loadPage(); else render(); break;
    case ActionKind::Room:
        model.chooseRoom(item->target.id); pageOffset = 0; loadPage(); break;
    case ActionKind::Toggle: {
        bool checked = lv_obj_has_state(lv_event_get_target(event), LV_STATE_CHECKED);
        if (!model.toggle(item->target, checked)) {
            lv_obj_clear_state(lv_event_get_target(event), LV_STATE_CHECKED);
            notice("Максимум 12 плиток; группа также имеет лимит устройств");
        } else notice(("Выбрано: " + String(model.count)).c_str());
        break;
    }
    case ActionKind::Next: pageOffset += 8; loadPage(); break;
    case ActionKind::Previous: pageOffset = max(0, pageOffset - 8); loadPage(); break;
    case ActionKind::Save: {
        DynamicJsonDocument config(16384), previous(16384);
        deserializeJson(previous, prefs.getString("selection", ""));
        config["name"] = PANEL_NAME; config["room_id"] = model.room;
        JsonArray widgets = config.createNestedArray("widgets");
        for (size_t i = 0; i < model.count; ++i) {
            JsonObject target = widgets.createNestedObject();
            target["kind"] = model.selected[i].group ? "group" : "device"; target["id"] = model.selected[i].id;
            // Keep explicit capability selections configured through REST for retained tiles.
            for (JsonObject old : previous["widgets"].as<JsonArray>())
                if (old["id"] == target["id"] && old["kind"] == target["kind"])
                    target["capabilities"] = old["capabilities"];
        }
        if (config.overflowed()) { notice("Конфигурация слишком большая"); break; }
        String payload; serializeJson(config, payload); send(RequestKind::Save, "PUT", displayPath(), payload);
        notice("Сохранение…"); break;
    }
    case ActionKind::Group: model.openGroup(item->target.id); render(); break;
    case ActionKind::Device: {
        uint32_t parent = model.page == panel::Page::Group ? model.activeGroup : 0;
        model.openDevice(item->target.id, parent); render(); break;
    }
    case ActionKind::Boolean: value["value"] = item->boolean; command(item, value["value"]); break;
    case ActionKind::Numeric: {
        double number = panel::numericValue(lv_slider_get_value(item->input), item->minimum, item->maximum, item->step);
        // Integer capabilities must serialize as integers: the REST API validates types strictly.
        if (device(item->target.id)["capabilities"][item->capability]["type"] == "integer") value["value"] = lround(number);
        else value["value"] = number;
        command(item, value["value"]); break;
    }
    case ActionKind::Enum: {
        uint16_t selected = lv_dropdown_get_selected(item->input);
        value["value"] = device(item->target.id)["capabilities"][item->capability]["enum"][selected];
        command(item, value["value"]); break;
    }
    case ActionKind::Color:
        colorCapability = item->capability; model.page = panel::Page::Color; render(); break;
    case ActionKind::ApplyColor: {
        lv_color_hsv_t hsv = lv_colorwheel_get_hsv(item->input);
        value["value"]["h"] = hsv.h;
        value["value"]["s"] = lv_slider_get_value(item->secondary);
        value["value"]["v"] = lv_slider_get_value(item->tertiary);
        command(item, value["value"]); break;
    }
    }
}
static void restoreConfig(JsonDocument &config) {
    model.room = config["room_id"] | 0; model.count = 0;
    for (JsonObject target : config["widgets"].as<JsonArray>())
        model.toggle({target["id"].as<uint32_t>(), target["kind"] == "group"}, true);
    configured = model.room > 0;
    model.checkpoint();
}
static void handle(Result *result) {
    busy = false;
    if (result->status >= 200 && result->status < 300) {
        DynamicJsonDocument parsed(32768);
        if (deserializeJson(parsed, result->body) || parsed.overflowed()) {
            notice("Ответ слишком большой или повреждён"); delete result; return;
        }
        lastGood = millis(); commandAllowed = true;
        if (result->kind == RequestKind::Config || result->kind == RequestKind::Save) {
            restoreConfig(parsed);
            String config; serializeJson(parsed, config); prefs.putString("selection", config);
            model.page = panel::Page::Dashboard; ++generation; requestRefresh = true;
            send(RequestKind::Dashboard, "GET", displayPath("/dashboard"));
        } else if ((result->kind == RequestKind::Rooms || result->kind == RequestKind::Options) && result->generation == generation) {
            pageData.set(parsed);
            if (pageData.overflowed()) { pageData.clear(); notice("Слишком много данных на странице"); }
            else render();
        } else if (result->kind == RequestKind::Dashboard && result->generation == generation) {
            snapshot.set(parsed); nextRead = millis() + 10000;
            if (model.page == panel::Page::Dashboard || model.page == panel::Page::Group) render();
            else if (model.page == panel::Page::Device) {
                JsonObject card = device(model.activeDevice);
                for (size_t i = 0; i < readingCount; ++i) {
                    String name = readingLabels[i].capability;
                    String text = caption(name) + ": " + readingText(card, name.c_str());
                    lv_label_set_text(readingLabels[i].object, text.c_str());
                }
            }
        } else if (result->kind == RequestKind::Command) {
            requestRefresh = true; nextRead = millis() + 2000;
            bool all = parsed["all_acknowledged"] | true;
            notice(all ? "Команда принята. Ждём статус" : "Часть команд не подтверждена. Ждём статус");
        } else if (result->kind == RequestKind::Refresh) nextRead = millis() + 2000;
    } else if (result->kind == RequestKind::Config && result->status == 404) {
        configured = false; snapshot.clear(); model.page = panel::Page::Rooms; pageOffset = 0; loadPage();
    } else {
        if (result->status <= 0 || result->status == 401 || result->status == 403) { lastGood = 0; commandAllowed = false; }
        // A timed-out write may have reached the device. It is never retried automatically.
        if (result->kind == RequestKind::Command || result->kind == RequestKind::Save)
            notice(result->status == 422 ? "Проверьте выбор и настройки устройств" : "Нет подтверждения. Проверьте состояние; повтор вручную");
        else notice(result->status == 401 ? "Проверьте API-ключ панели" : "Не удалось получить данные");
        nextRead = millis() + 10000;
    }
    delete result;
}
static void flush(lv_disp_drv_t *driver, const lv_area_t *area, lv_color_t *colors) {
    screen.startWrite();
    screen.pushImage(area->x1, area->y1, area->x2 - area->x1 + 1, area->y2 - area->y1 + 1,
        reinterpret_cast<lgfx::rgb565_t *>(colors));
    screen.endWrite(); lv_disp_flush_ready(driver);
}
static void touch(lv_indev_drv_t *, lv_indev_data_t *data) {
    uint16_t x, y;
    if (screen.getTouch(&x, &y)) { data->state = LV_INDEV_STATE_PR; data->point.x = x; data->point.y = y; }
    else data->state = LV_INDEV_STATE_REL;
}
void setup() {
    Serial.begin(115200); screen.init(); screen.setRotation(DISPLAY_ROTATION); screen.setBrightness(180);
    lv_init(); lv_disp_draw_buf_init(&drawBuffer, pixels, nullptr, 480 * 12);
    static lv_disp_drv_t display; lv_disp_drv_init(&display);
    display.hor_res = screen.width(); display.ver_res = screen.height(); display.flush_cb = flush; display.draw_buf = &drawBuffer;
    lv_disp_t *registered = lv_disp_drv_register(&display);
    lv_theme_t *theme = lv_theme_default_init(registered, lv_palette_main(LV_PALETTE_BLUE), lv_palette_main(LV_PALETTE_CYAN), true, &panel_font);
    lv_disp_set_theme(registered, theme);
    static lv_indev_drv_t input; lv_indev_drv_init(&input); input.type = LV_INDEV_TYPE_POINTER; input.read_cb = touch; lv_indev_drv_register(&input);
    WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    panelId = PANEL_ID;
    if (!panelId.length()) { panelId = "panel-" + WiFi.macAddress(); panelId.replace(":", ""); panelId.toLowerCase(); }
    prefs.begin("smart-panel", false);
    DynamicJsonDocument config(16384);
    String saved = prefs.getString("selection", "");
    if (saved.length() && !deserializeJson(config, saved)) restoreConfig(config);
    jobs = xQueueCreate(1, sizeof(Job *)); replies = xQueueCreate(1, sizeof(Result *));
    xTaskCreate(networkTask, "panel-network", 8192, nullptr, 1, nullptr);
    render(); nextRead = 0;
}
void loop() {
    static uint32_t tick = millis(); uint32_t now = millis(); lv_tick_inc(now - tick); tick = now;
    Result *result = nullptr;
    if (xQueueReceive(replies, &result, 0) == pdTRUE) handle(result);
    if (!busy && WiFi.status() == WL_CONNECTED) {
        if (requestRefresh && configured) { requestRefresh = false; send(RequestKind::Refresh, "POST", displayPath("/refresh")); }
        else if (static_cast<int32_t>(now - nextRead) >= 0) {
            nextRead = now + 10000;
            if (model.page == panel::Page::Rooms || model.page == panel::Page::Selection) {
                // Retry reads only; keep the user's unsaved selection and page.
                if (pageData.isNull()) {
                    String query = "?offset=" + String(pageOffset) + "&limit=8";
                    if (model.page == panel::Page::Rooms) send(RequestKind::Rooms, "GET", displayPath("/rooms") + query);
                    else send(RequestKind::Options, "GET", displayPath("/options") + query + "&room_id=" + String(model.room));
                }
            }
            else if (!configured || snapshot.isNull()) send(RequestKind::Config, "GET", displayPath());
            else if (model.page == panel::Page::Dashboard || model.page == panel::Page::Group || model.page == panel::Page::Device)
                send(RequestKind::Dashboard, "GET", displayPath("/dashboard"));
        }
    }
    static bool wasConnected = false;
    bool online = connected();
    if (wasConnected != online) {
        wasConnected = online;
        // Repaint once so cached true/false never remains displayed as a live reading after disconnect.
        render();
    }
    lv_timer_handler(); delay(5);
}
