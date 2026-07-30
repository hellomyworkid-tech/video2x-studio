#pragma once

#include <deque>
#include <vector>

extern "C" {
#include <libavutil/frame.h>
}

namespace video2x {

class TemporalFrameBuffer {
   public:
    explicit TemporalFrameBuffer(size_t capacity);
    ~TemporalFrameBuffer();

    void push(AVFrame* frame);
    AVFrame* get_center_frame() const;
    std::vector<AVFrame*> get_window() const;
    void clear();

    [[nodiscard]] bool is_full() const { return buffer_.size() >= capacity_; }
    [[nodiscard]] size_t size() const { return buffer_.size(); }
    [[nodiscard]] size_t capacity() const { return capacity_; }

   private:
    size_t capacity_;
    std::deque<AVFrame*> buffer_;
};

}  // namespace video2x
