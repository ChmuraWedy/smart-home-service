#include "panel_model.hpp"
#include <cassert>
#include <cmath>
int main() {
    panel::Model m;
    m.chooseRoom(1);
    assert(m.toggle({11, true}, true)); // group tile is separate from device with same ID
    assert(m.toggle({11, false}, true));
    assert(m.count == 2);
    assert(m.toggle({11, true}, true) && m.count == 2);
    m.openGroup(11); m.openDevice(4, 11);
    m.page = panel::Page::Color; m.back(); assert(m.page == panel::Page::Device);
    m.back(); assert(m.page == panel::Page::Group); m.back(); assert(m.page == panel::Page::Dashboard);
    m.chooseRoom(2); assert(m.count == 0);
    for (unsigned i = 1; i <= 12; ++i) assert(m.toggle({i, false}, true));
    assert(!m.toggle({13, false}, true));
    assert(m.toggle({5, false}, false) && m.count == 11);
    assert(m.toggle({13, false}, true));
    assert(!panel::fresh(false, false, true)); // absent motion must not become inactive
    assert(!panel::fresh(true, true, true));
    assert(!panel::fresh(true, false, false));
    assert(panel::fresh(true, false, true));
    assert(panel::numericValue(500, 2700, 6500, 1) == 4600);
    assert(panel::numericValue(583, 5, 35, .5) == 22.5);
    assert(panel::numericValue(1000, 5, 35, .5) == 35);
    assert(panel::numericValue(0, 5, 35, .5) == 5);
    panel::Model saved;
    saved.chooseRoom(10); saved.toggle({1, true}, true); saved.toggle({5, false}, true); saved.checkpoint();
    saved.chooseRoom(20); saved.toggle({9, false}, true);
    saved.back(); assert(saved.page == panel::Page::Rooms);
    saved.back(); assert(saved.page == panel::Page::Dashboard && saved.room == 10);
    assert(saved.count == 2 && saved.contains({1, true}) && saved.contains({5, false}));
    assert(!saved.contains({9, false}));
    return 0;
}
