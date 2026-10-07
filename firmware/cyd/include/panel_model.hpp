#pragma once
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace panel {
enum class Page { Dashboard, Rooms, Selection, Group, Device, Color };
struct Target { uint32_t id; bool group; Target(uint32_t value = 0, bool isGroup = false) : id(value), group(isGroup) {} };
struct Model {
    static constexpr size_t capacity = 12;
    Page page = Page::Dashboard;
    uint32_t room = 0;
    uint32_t activeGroup = 0;
    uint32_t activeDevice = 0;
    Target selected[capacity];
    size_t count = 0;
    Target savedSelected[capacity];
    size_t savedCount = 0;
    uint32_t savedRoom = 0;
    void checkpoint() { savedRoom = room; savedCount = count; for (size_t i = 0; i < count; ++i) savedSelected[i] = selected[i]; }
    void cancelSelection() { room = savedRoom; count = savedCount; for (size_t i = 0; i < count; ++i) selected[i] = savedSelected[i]; page = Page::Dashboard; }
    void chooseRoom(uint32_t id) { if (room != id) { room = id; count = 0; } page = Page::Selection; }
    bool contains(Target item) const { for (size_t i = 0; i < count; ++i) if (selected[i].id == item.id && selected[i].group == item.group) return true; return false; }
    bool toggle(Target item, bool checked) {
        for (size_t i = 0; i < count; ++i) {
            if (selected[i].id == item.id && selected[i].group == item.group) {
                if (!checked) { for (size_t j = i+1; j < count; ++j) selected[j-1] = selected[j]; --count; }
                return true;
            }
        }
        if (!checked) return true;
        if (count >= capacity || item.id == 0) return false;
        selected[count++] = item;
        return true;
    }
    void openGroup(uint32_t id) { activeGroup = id; activeDevice = 0; page = Page::Group; }
    void openDevice(uint32_t id, uint32_t group = 0) { activeDevice = id; activeGroup = group; page = Page::Device; }
    void back() {
        if (page == Page::Color) page = Page::Device;
        else if (page == Page::Device && activeGroup) page = Page::Group;
        else if (page == Page::Selection) page = Page::Rooms;
        else if (page == Page::Rooms) cancelSelection();
        else page = Page::Dashboard;
    }
};
inline bool fresh(bool known, bool stale, bool connected) { return known && !stale && connected; }
// Preserve complete UTF-8 glyphs when bounding status text for the small display.
inline size_t utf8PrefixLength(const char *text, size_t length, size_t maximum) {
    if (length <= maximum) return length;
    size_t end = maximum;
    while (end > 0 && (static_cast<uint8_t>(text[end]) & 0xc0) == 0x80) --end;
    return end;
}
inline double numericValue(int tick, double min, double max, double step) {
    double value = min + (max-min) * tick / 1000.0;
    if (step > 0) value = min + std::round((value-min)/step) * step;
    return value < min ? min : value > max ? max : value;
}
}
