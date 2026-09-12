#include <stdint.h>
#include <wasm_simd128.h>

// Compare two checkpoint images in reusable memory. Only changed 4 KiB pages
// need JS-owned copies; unchanged pages are shared by all retained snapshots.
__attribute__((export_name("changed_pages")))
uint32_t changed_pages(const uint8_t *current, uint8_t *previous,
                       uint32_t length, uint32_t *indices) {
    uint32_t count = 0;
    for (uint32_t page = 0; page < length; page += 4096) {
        v128_t difference = wasm_i32x4_splat(0);
        for (uint32_t i = 0; i < 4096; i += 16) {
            difference = wasm_v128_or(difference, wasm_v128_xor(
                wasm_v128_load(current + page + i),
                wasm_v128_load(previous + page + i)));
        }
        if (wasm_v128_any_true(difference)) {
            indices[count++] = page / 4096;
            for (uint32_t i = 0; i < 4096; i += 16) {
                wasm_v128_store(previous + page + i,
                    wasm_v128_load(current + page + i));
            }
        }
    }
    return count;
}
