#include "temporal_buffer.h"

namespace video2x {

TemporalFrameBuffer::TemporalFrameBuffer(size_t capacity)
    : capacity_(capacity) {}

TemporalFrameBuffer::~TemporalFrameBuffer() {
    clear();
}

void TemporalFrameBuffer::push(AVFrame* frame) {
    if (!frame) return;

    AVFrame* cloned = av_frame_clone(frame);
    buffer_.push_back(cloned);

    if (buffer_.size() > capacity_) {
        AVFrame* oldest = buffer_.front();
        buffer_.pop_front();
        av_frame_free(&oldest);
    }
}

AVFrame* TemporalFrameBuffer::get_center_frame() const {
    if (buffer_.empty()) return nullptr;
    return buffer_[buffer_.size() / 2];
}

std::vector<AVFrame*> TemporalFrameBuffer::get_window() const {
    return std::vector<AVFrame*>(buffer_.begin(), buffer_.end());
}

void TemporalFrameBuffer::clear() {
    for (AVFrame* frame : buffer_) {
        if (frame) {
            av_frame_free(&frame);
        }
    }
    buffer_.clear();
}

}  // namespace video2x
