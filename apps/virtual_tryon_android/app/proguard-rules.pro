# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Add project specific ProGuard rules here.
-dontwarn com.oracle.svm.core.annotate.Delete
-dontwarn com.oracle.svm.core.annotate.Substitute
-dontwarn com.oracle.svm.core.annotate.TargetClass
-dontwarn java.beans.ConstructorProperties
-dontwarn java.beans.Transient
-dontwarn javax.lang.model.element.AnnotationMirror
-dontwarn javax.lang.model.element.AnnotationValue
-dontwarn javax.lang.model.element.AnnotationValueVisitor
-dontwarn javax.lang.model.element.ElementVisitor
-dontwarn javax.lang.model.element.ExecutableElement
-dontwarn javax.lang.model.element.Name
-dontwarn javax.lang.model.element.TypeElement
-dontwarn javax.lang.model.element.VariableElement
-dontwarn javax.lang.model.type.DeclaredType
-dontwarn javax.lang.model.type.ErrorType
-dontwarn javax.lang.model.type.ExecutableType
-dontwarn javax.lang.model.type.TypeKind
-dontwarn javax.lang.model.util.AbstractElementVisitor8
-dontwarn javax.lang.model.util.ElementFilter
-dontwarn javax.lang.model.util.SimpleAnnotationValueVisitor8
-dontwarn javax.lang.model.util.SimpleElementVisitor8
-dontwarn javax.tools.SimpleJavaFileObject
-dontwarn org.w3c.dom.bootstrap.DOMImplementationRegistry
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

##############################################
# KEEP ANNOTATIONS (CRITICAL FOR RETROFIT)
##############################################
-keepattributes *Annotation*
-keepattributes Signature

##############################################
# RETROFIT
##############################################
-keep class retrofit2.** { *; }
-keep interface retrofit2.** { *; }

##############################################
# OKHTTP
##############################################
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

##############################################
# GSON (if used)
##############################################
-keep class com.google.gson.** { *; }
-keep class * {
    @com.google.gson.annotations.SerializedName <fields>;
}

##############################################
# KEEP YOUR API INTERFACES (VERY IMPORTANT)
##############################################
-keep interface * {
    @retrofit2.http.* <methods>;
}

##############################################
# KEEP RESPONSE MODELS
##############################################
-keep class * implements java.io.Serializable { *; }

##############################################
# KOTLIN COROUTINES (if using suspend)
##############################################
-keepclassmembers class kotlin.coroutines.Continuation { *; }

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

##############################################
# FIX R8 javax.lang.model crash (FULL COVERAGE)
##############################################
-dontwarn javax.lang.model.**
-dontwarn javax.annotation.**
-dontwarn javax.tools.**

##############################################
# AUTO VALUE / JAVAPOET (CAUSE OF YOUR ERROR)
##############################################
-dontwarn autovalue.shaded.**
-dontwarn com.squareup.javapoet.**
-dontwarn com.google.auto.**

# OkHttp platform warning suppression
-dontwarn org.bouncycastle.jsse.**
-dontwarn org.bouncycastle.jsse.provider.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**

# Keep Kotlin Metadata (required for Jackson Kotlin module reflection)
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,Signature,InnerClasses,EnclosingMethod,AnnotationDefault,*Annotation*,Metadata

# Keep Jackson Classes and Annotations
-keep class com.fasterxml.jackson.** { *; }
-dontwarn com.fasterxml.jackson.**
-keepattributes *Annotation*,EnclosingMethod,Signature,InnerClasses

# Keep Response API Models to prevent R8 serialization/deserialization crashes
-keep class tryme.nice.interactive.viewmodel.** { *; }

##############################################
# FIREBASE CRASHLYTICS
# Keep line numbers for readable stack traces; the Crashlytics Gradle plugin
# uploads mapping.txt on release builds to deobfuscate class/method names.
##############################################
-keepattributes SourceFile,LineNumberTable
-keep public class * extends java.lang.Exception
-renamesourcefileattribute SourceFile