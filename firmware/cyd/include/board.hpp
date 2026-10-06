#pragma once
#include <LovyanGFX.hpp>

class PanelDriver : public lgfx::LGFX_Device {
#if defined(CYD_035R) || defined(CYD_035C)
    lgfx::Panel_ST7796 panel;
#else
#if defined(CYD_ST7789) || defined(CYD_028C)
    lgfx::Panel_ST7789 panel;
#else
    lgfx::Panel_ILI9341 panel;
#endif
#endif
    lgfx::Bus_SPI bus;
    lgfx::Light_PWM light;
#if defined(CYD_028C)
    lgfx::Touch_CST816S touch;
#elif defined(CYD_035C)
    lgfx::Touch_GT911 touch;
#else
    lgfx::Touch_XPT2046 touch;
#endif
public:
    PanelDriver() {
        auto b = bus.config();
        b.spi_host = HSPI_HOST;
#if defined(CYD_ST7789) || defined(CYD_028C)
        b.spi_mode = 3;
#else
        b.spi_mode = 0;
#endif
        b.freq_write = 40000000;
        b.freq_read = 16000000;
        b.spi_3wire = false;
        b.use_lock = true;
        b.dma_channel = SPI_DMA_CH_AUTO;
        b.pin_sclk = 14; b.pin_mosi = 13; b.pin_miso = 12; b.pin_dc = 2;
        bus.config(b);
        panel.setBus(&bus);
        auto p = panel.config();
        p.pin_cs = 15; p.pin_rst = -1; p.pin_busy = -1;
#if defined(CYD_035R) || defined(CYD_035C)
        p.panel_width = 320; p.panel_height = 480;
#else
        p.panel_width = 240; p.panel_height = 320;
#endif
        p.invert = DISPLAY_INVERT; p.rgb_order = DISPLAY_RGB_ORDER;
        p.bus_shared = true;
        panel.config(p);
        auto l = light.config();
#if defined(CYD_035R) || defined(CYD_035C) || defined(CYD_028C)
        l.pin_bl = 27;
#else
        l.pin_bl = 21;
#endif
        l.freq = 22000; l.pwm_channel = 7;
        light.config(l); panel.setLight(&light);
        auto t = touch.config();
        t.offset_rotation = TOUCH_ROTATION;
        t.bus_shared = false;
#if defined(CYD_028C) || defined(CYD_035C)
        t.i2c_port = 0; t.pin_sda = 33; t.pin_scl = 32; t.pin_int = 21;
        t.freq = 400000; t.pin_rst = 25;
        t.x_min = 0; t.y_min = 0;
#if defined(CYD_028C)
        t.x_max = 239; t.y_max = 319; t.i2c_addr = 0x15;
#else
        t.x_max = 319; t.y_max = 479; t.i2c_addr = 0x5d;
#endif
#else
#if defined(CYD_035R)
        t.spi_host = HSPI_HOST; t.freq = 1000000; t.bus_shared = true;
        t.pin_sclk = 14; t.pin_mosi = 13; t.pin_miso = 12;
#else
        t.spi_host = VSPI_HOST; t.freq = 1000000;
        t.pin_sclk = 25; t.pin_mosi = 32; t.pin_miso = 39;
#endif
        t.pin_cs = 33; t.pin_int = 36;
        t.x_min = TOUCH_X_MIN; t.x_max = TOUCH_X_MAX;
        t.y_min = TOUCH_Y_MIN; t.y_max = TOUCH_Y_MAX;
#endif
        touch.config(t); panel.setTouch(&touch); setPanel(&panel);
    }
};
