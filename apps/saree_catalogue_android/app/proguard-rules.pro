# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.

# Retrofit Keep Rules
-keepattributes Signature, InnerClasses, EnclosingMethod
-keep class retrofit2.** { *; }
-dontwarn retrofit2.**
-keepclassmembers class * {
    @retrofit2.http.** <methods>;
}

# OkHttp Platform Rules & Warning Suppressions
-dontwarn org.bouncycastle.jsse.**
-dontwarn org.bouncycastle.jsse.provider.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
-dontwarn javax.annotation.**
-dontwarn org.codehaus.mojo.animalsniffer.IgnoreJRERequirement

# Jackson JSON Parser Keep Rules
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-keep class com.fasterxml.jackson.** { *; }
-dontwarn com.fasterxml.jackson.**
-keepattributes *Annotation*,EnclosingMethod,InnerClasses,Signature

# Glide Keep Rules
-keep public class * extends com.bumptech.glide.module.AppGlideModule
-keep public class * extends com.bumptech.glide.module.LibraryGlideModule
-keep class com.bumptech.glide.** { *; }
-dontwarn com.bumptech.glide.**
-keepclassmembers class * {
    @com.bumptech.glide.annotation.GlideOption <methods>;
    @com.bumptech.glide.annotation.GlideExtension <methods>;
}

# Lottie Keep Rules
-keep class com.airbnb.lottie.** { *; }

# Keep data models and serialization classes to prevent Jackson mapper failure
-keep class tryme.nice.trymeadmin.viewmodels.** { *; }
-keep class tryme.nice.interactive.viewmodel.** { *; }
-keep class tryme.nice.trymeadmin.databinding.** { *; }
-keep class tryme.nice.trymeadmin.dialog.** { *; }

# Preserve line number information for debugging stack traces
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile