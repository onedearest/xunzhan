#include <jni.h>

#include <string>
#include <vector>

#include "node.h"

extern "C" JNIEXPORT jint JNICALL
Java_local_xunzhan_phone_DeskApp_startNodeWithArguments(JNIEnv *env, jobject, jobjectArray arguments) {
    const jsize count = env->GetArrayLength(arguments);
    std::vector<std::string> storage(static_cast<size_t>(count));
    std::vector<char *> argv(static_cast<size_t>(count));
    for (jsize index = 0; index < count; index += 1) {
        auto current = static_cast<jstring>(env->GetObjectArrayElement(arguments, index));
        const char *chars = env->GetStringUTFChars(current, nullptr);
        storage[static_cast<size_t>(index)] = chars == nullptr ? "" : chars;
        env->ReleaseStringUTFChars(current, chars);
        argv[static_cast<size_t>(index)] = storage[static_cast<size_t>(index)].data();
    }
    return node::Start(count, argv.data());
}
