package tryme.nice.trymeadmin.dialog

import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.databinding.DialogUploadPhotoBinding
import tryme.nice.trymeadmin.utils.ViewControll
import tryme.nice.trymeadmin.viewmodels.ProductUploadViewModel
import tryme.nice.interactive.Loader.LoaderManager
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import androidx.core.view.isVisible
import androidx.lifecycle.ViewModelProvider
import com.bumptech.glide.Glide
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import java.io.File

import android.app.Activity
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContracts
import com.yalantis.ucrop.UCrop
import com.yalantis.ucrop.util.FileUtils
import java.util.UUID

class UploadPhotoDialog(
    private val selectedPhotoPath: String,
    private val subcategoryId: String,
    private val sareeStyleId: String? = null,
    private val secondaryPhotoPath: String? = null,
    private val onCompleted: (String) -> Unit
) : BottomSheetDialogFragment() {

    private enum class CropTarget { SINGLE, BODY, PALLU }

    private lateinit var binding: DialogUploadPhotoBinding
    private lateinit var productUploadViewmodel: ProductUploadViewModel
    private var isGenerateApiRunning = false

    private var activeSelectedPath: String = selectedPhotoPath
    private var activeSecondaryPath: String? = secondaryPhotoPath
    private var activeCropTarget: CropTarget = CropTarget.SINGLE

    private val uCropActivityResult =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            try {
                if (result.resultCode == Activity.RESULT_OK && result.data != null) {
                    val uri = UCrop.getOutput(result.data!!)
                    if (uri != null) {
                        val file = getFileFromUriSafe(requireContext(), uri)
                        if (file != null && file.exists()) {
                            when (activeCropTarget) {
                                CropTarget.SINGLE -> {
                                    activeSelectedPath = file.absolutePath
                                    Glide.with(requireActivity()).load(file).into(binding.imgSelected)
                                }
                                CropTarget.BODY -> {
                                    activeSelectedPath = file.absolutePath
                                    Glide.with(requireActivity()).load(file).into(binding.imgBody)
                                }
                                CropTarget.PALLU -> {
                                    activeSecondaryPath = file.absolutePath
                                    Glide.with(requireActivity()).load(file).into(binding.imgPallu)
                                }
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }

    private fun startUCropForPath(path: String, target: CropTarget) {
        try {
            activeCropTarget = target
            val sourceUri = Uri.fromFile(File(path))
            val uniqueFileName = "cropped_${UUID.randomUUID()}.jpg"
            val destinationUri = Uri.fromFile(File(requireContext().cacheDir, uniqueFileName))

            val options = UCrop.Options().apply {
                setCompressionFormat(Bitmap.CompressFormat.JPEG)
                setCompressionQuality(100)
                setFreeStyleCropEnabled(true)
                setHideBottomControls(false)
                setShowCropGrid(true)
                setShowCropFrame(true)
            }

            val intent = UCrop.of(sourceUri, destinationUri)
                .withOptions(options)
                .getIntent(requireContext())

            uCropActivityResult.launch(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun getFileFromUriSafe(context: android.content.Context, uri: Uri): File? {
        try {
            val path = FileUtils.getPath(context, uri)
            if (!path.isNullOrBlank()) {
                val file = File(path)
                if (file.exists() && file.length() > 0) return file
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return try {
            val inputStream = context.contentResolver.openInputStream(uri) ?: return null
            val file = File(context.cacheDir, "cropped_${System.currentTimeMillis()}.jpg")
            java.io.FileOutputStream(file).use { out -> inputStream.copyTo(out) }
            if (file.exists() && file.length() > 0) file else null
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        binding = DialogUploadPhotoBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        return super.onCreateDialog(savedInstanceState).apply {
            setOnShowListener { dialogInterface ->
                val bottomSheet = (dialogInterface as BottomSheetDialog)
                    .findViewById<View>(com.google.android.material.R.id.design_bottom_sheet)

                bottomSheet?.background = ColorDrawable(Color.TRANSPARENT)
                if (bottomSheet != null) {
                    bottomSheet.setBackgroundColor(Color.TRANSPARENT)
                    val behavior = BottomSheetBehavior.from(bottomSheet)
                    behavior.state = BottomSheetBehavior.STATE_EXPANDED
                    behavior.skipCollapsed = true
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        dialog?.let { dlg ->
            dlg.setCancelable(false)
            dlg.setCanceledOnTouchOutside(false)
            val bottomSheet =
                dlg.findViewById<View>(com.google.android.material.R.id.design_bottom_sheet)
            bottomSheet?.layoutParams?.height = ViewGroup.LayoutParams.MATCH_PARENT
        }
    }

    override fun getTheme(): Int = R.style.BottomSheetDialogThemeFullWidth

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        initView()
    }

    private fun initView() {
        productUploadViewmodel = ViewModelProvider(requireParentFragment()).get(ProductUploadViewModel::class.java)

        val secPath = activeSecondaryPath
        if (!secPath.isNullOrEmpty()) {
            // Separate / Multiple Upload Mode: Show both Body & Pallu images
            binding.cardSingleImage.isVisible = false
            binding.llMultipleImages.isVisible = true

            Glide.with(requireActivity()).load(File(activeSelectedPath)).into(binding.imgBody)
            Glide.with(requireActivity()).load(File(secPath)).into(binding.imgPallu)
        } else {
            // Single Upload Mode: Show single image
            binding.cardSingleImage.isVisible = true
            binding.llMultipleImages.isVisible = false

            Glide.with(requireActivity()).load(File(activeSelectedPath)).into(binding.imgSelected)
        }

        binding.btnCropSingle.setOnClickListener {
            startUCropForPath(activeSelectedPath, CropTarget.SINGLE)
        }
        binding.btnCropBody.setOnClickListener {
            startUCropForPath(activeSelectedPath, CropTarget.BODY)
        }
        binding.btnCropPallu.setOnClickListener {
            activeSecondaryPath?.let { path ->
                startUCropForPath(path, CropTarget.PALLU)
            }
        }

        binding.iconCancle.setOnClickListener {
            dismiss()
        }
        binding.btnUpload.setOnClickListener {
            uploadProductImageAPI()
        }
    }

    private fun uploadProductImageAPI() {
        val act = activity ?: return
        if (!isAdded) return
        keepScreenOn()
        val decorView = (dialog?.window?.decorView as? ViewGroup)
            ?: (act.findViewById<ViewGroup>(android.R.id.content))
        if (decorView != null) {
            LoaderManager.show(act, decorView, true)
            LoaderManager.setMessage(getString(R.string.uploading_your_product))
        }

        val secondaryFile = activeSecondaryPath?.takeIf { it.isNotEmpty() }?.let { File(it) }
        productUploadViewmodel.generateProduct(File(activeSelectedPath), subcategoryId, sareeStyleId, secondaryFile)

        productUploadViewmodel.generateState.observe(viewLifecycleOwner) { state ->
            if (state == null) return@observe
            val currentAct = activity ?: return@observe
            if (!isAdded) return@observe
            when (state) {
                is ProductUploadViewModel.GenerateState.Completed -> {
                    productUploadViewmodel.resetGenerateState()
                    LoaderManager.remove(currentAct)
                    clearKeepScreenOn()
                    onCompleted(state.resultUrl)
                    dismissAllowingStateLoss()
                }
                is ProductUploadViewModel.GenerateState.Failed -> {
                    productUploadViewmodel.resetGenerateState()
                    LoaderManager.remove(currentAct)
                    clearKeepScreenOn()
                    ViewControll.showMessage(currentAct, state.message)
                    dismissAllowingStateLoss()
                }
                else -> { /* Uploading / Generating */ }
            }
        }
    }

    private fun keepScreenOn() {
        isGenerateApiRunning = true
        activity?.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun clearKeepScreenOn() {
        isGenerateApiRunning = false
        activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onDestroyView() {
        if (isGenerateApiRunning) {
            clearKeepScreenOn()
        }
        super.onDestroyView()
    }

    sealed class ImageSourceType {
        data class FromFile(val file: File) : ImageSourceType()
        data class FromUrl(val url: String) : ImageSourceType()
        data class FromPath(val path: String) : ImageSourceType()
    }
}
