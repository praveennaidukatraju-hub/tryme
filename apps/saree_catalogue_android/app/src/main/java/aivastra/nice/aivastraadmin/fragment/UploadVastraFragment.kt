package tryme.nice.trymeadmin.fragment

import tryme.nice.trymeadmin.R
import tryme.nice.trymeadmin.activity.DashBoardActivity
import tryme.nice.trymeadmin.activity.ProfileActivity
import android.os.Bundle
import androidx.fragment.app.Fragment
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import tryme.nice.trymeadmin.databinding.FragmentUploadVastraBinding
import tryme.nice.trymeadmin.dialog.ShowErrorAlertDialog
import tryme.nice.trymeadmin.dialog.UploadPhotoDialog
import tryme.nice.trymeadmin.utils.ViewControll
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSubcategory
import tryme.nice.trymeadmin.viewmodels.ProductUploadViewModel
import tryme.nice.interactive.Loader.LoaderManager
import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.widget.ArrayAdapter
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.isVisible
import androidx.lifecycle.ViewModelProvider
import com.bumptech.glide.Glide
import com.yalantis.ucrop.UCrop
import com.yalantis.ucrop.util.FileUtils
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSareeStyle

class UploadVastraFragment : Fragment(), View.OnClickListener {

    enum class UploadMode {
        SINGLE, MULTIPLE
    }

    enum class SubStep {
        MODE_SELECTION, SINGLE_UPLOAD, MULTIPLE_UPLOAD, STYLE_SELECTION
    }

    enum class PhotoTarget {
        SINGLE, BODY, PALLU
    }

    private lateinit var binding: FragmentUploadVastraBinding
    private lateinit var productUploadViewmodel: ProductUploadViewModel
    private var lastGeneratedResultUrl: String = ""
    private var selectedSubcategoryId: String? = null
    private var selectedStyleId: String? = null
    private var currentPhotoUri: Uri? = null
    private var selectedStyleLabel: String = "Nivi"
    private var availableStyles: List<MerchantCatalogSareeStyle> = emptyList()
    private var currentFilteredStyles: List<MerchantCatalogSareeStyle> = emptyList()

    private var currentMode: UploadMode = UploadMode.SINGLE
    private var currentSubStep: SubStep = SubStep.MODE_SELECTION
    private var currentPhotoTarget: PhotoTarget = PhotoTarget.SINGLE

    private var singlePhotoPath: String? = null
    private var bodyPhotoPath: String? = null
    private var palluPhotoPath: String? = null

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        binding = FragmentUploadVastraBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        initView()
    }

    private fun initView() {
        productUploadViewmodel = ViewModelProvider(this).get(ProductUploadViewModel::class.java)

        // Mode selection cards
        binding.cardModeSingle.setOnClickListener(this)
        binding.cardModeMultiple.setOnClickListener(this)

        // Single upload step listeners
        binding.btnBackSingle.setOnClickListener(this)
        binding.btnBackSingleBottom.setOnClickListener(this)
        binding.btnContinueSingle.setOnClickListener(this)
        binding.cardUploadSingle.setOnClickListener(this)

        // Separate / Multiple upload step listeners
        binding.btnBackMultiple.setOnClickListener(this)
        binding.btnBackMultipleBottom.setOnClickListener(this)
        binding.btnContinueMultiple.setOnClickListener(this)
        binding.cardUploadBody.setOnClickListener(this)
        binding.cardUploadPallu.setOnClickListener(this)

        // Style selection step listeners
        binding.btnBackStyle.setOnClickListener(this)
        binding.cardStyle1.setOnClickListener(this)
        binding.cardStyle2.setOnClickListener(this)
        binding.btnApplyStyle.setOnClickListener(this)

        // Other header / result screen listeners
        binding.imgProfile.setOnClickListener(this)
        binding.btnCancel.setOnClickListener(this)
        binding.btnUpload.setOnClickListener(this)

        showSubStep(SubStep.MODE_SELECTION)

        binding.llSamplePhoto.post {
            val h = binding.llSamplePhoto.height
            val params = binding.llTitle.layoutParams
            params.height = h
            binding.llTitle.layoutParams = params
        }
        getSubcategoryData()
        getSareeStylesData()
    }

    private fun showSubStep(step: SubStep) {
        currentSubStep = step
        binding.llUploadProduct.isVisible = true
        binding.llAddProduct.isVisible = false

        binding.llStep0ModeSelection.isVisible = (step == SubStep.MODE_SELECTION)
        binding.llStep1aSingleUpload.isVisible = (step == SubStep.SINGLE_UPLOAD)
        binding.llStep1bMultipleUpload.isVisible = (step == SubStep.MULTIPLE_UPLOAD)
        binding.llStep2ChooseStyle.isVisible = (step == SubStep.STYLE_SELECTION)

        if (step == SubStep.SINGLE_UPLOAD) {
            val hasPhoto = !singlePhotoPath.isNullOrEmpty() && File(singlePhotoPath!!).exists()
            binding.imgPreviewSingle.isVisible = hasPhoto
            binding.btnChangeSingleOverlay.isVisible = hasPhoto
            binding.llPromptSingle.isVisible = !hasPhoto
            if (hasPhoto) {
                Glide.with(requireActivity()).load(File(singlePhotoPath!!)).into(binding.imgPreviewSingle)
            }
        } else if (step == SubStep.MULTIPLE_UPLOAD) {
            val hasBody = !bodyPhotoPath.isNullOrEmpty() && File(bodyPhotoPath!!).exists()
            binding.imgPreviewBody.isVisible = hasBody
            binding.btnChangeBodyOverlay.isVisible = hasBody
            binding.llPromptBody.isVisible = !hasBody
            if (hasBody) {
                Glide.with(requireActivity()).load(File(bodyPhotoPath!!)).into(binding.imgPreviewBody)
            }

            val hasPallu = !palluPhotoPath.isNullOrEmpty() && File(palluPhotoPath!!).exists()
            binding.imgPreviewPallu.isVisible = hasPallu
            binding.btnChangePalluOverlay.isVisible = hasPallu
            binding.llPromptPallu.isVisible = !hasPallu
            if (hasPallu) {
                Glide.with(requireActivity()).load(File(palluPhotoPath!!)).into(binding.imgPreviewPallu)
            }
        }

        if (step == SubStep.STYLE_SELECTION) {
            updateStyleSelectionUi()
        }
    }

    private fun showImageOptionDialog(target: PhotoTarget) {
        currentPhotoTarget = target
        val currentPath = when (target) {
            PhotoTarget.SINGLE -> singlePhotoPath
            PhotoTarget.BODY -> bodyPhotoPath
            PhotoTarget.PALLU -> palluPhotoPath
        }

        val hasImage = !currentPath.isNullOrEmpty() && File(currentPath).exists()
        val optionsList = mutableListOf<CharSequence>()
        if (hasImage) {
            optionsList.add("Crop Image")
        }
        optionsList.add("Take Photo")
        optionsList.add("Choose from Gallery")
        optionsList.add("Cancel")

        val options = optionsList.toTypedArray()
        val builder = androidx.appcompat.app.AlertDialog.Builder(requireActivity())
        builder.setTitle("Select Image Option")
        builder.setItems(options) { dialog, item ->
            when (options[item]) {
                "Crop Image" -> {
                    currentPath?.let { path ->
                        startUCropImage(Uri.fromFile(File(path)))
                    }
                }
                "Take Photo" -> {
                    checkPermissionsAndStartCamera()
                }
                "Choose from Gallery" -> {
                    selectImageLauncher.launch("image/*")
                }
                "Cancel" -> {
                    dialog.dismiss()
                }
            }
        }
        builder.show()
    }

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { isGranted ->
            if (isGranted) {
                dispatchTakePictureIntent()
            } else {
                Toast.makeText(requireActivity(), "Camera permission is required to take photos", Toast.LENGTH_SHORT).show()
            }
        }

    private fun checkPermissionsAndStartCamera() {
        val cameraPermission = Manifest.permission.CAMERA
        if (ContextCompat.checkSelfPermission(requireActivity(), cameraPermission) == PackageManager.PERMISSION_GRANTED) {
            dispatchTakePictureIntent()
        } else {
            cameraPermissionLauncher.launch(cameraPermission)
        }
    }

    private fun dispatchTakePictureIntent() {
        try {
            val takePictureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            takePictureIntent.putExtra("android.intent.extras.CAMERA_FACING", 1)
            takePictureIntent.putExtra("android.intent.extras.LENS_FACING_FRONT", 1)
            takePictureIntent.putExtra("android.intent.extras.USE_FRONT_CAMERA", true)

            val photoURI = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.TITLE, "IMG_${System.currentTimeMillis()}")
                    put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                    put(MediaStore.Images.Media.RELATIVE_PATH, "DCIM/Camera")
                }
                requireActivity().contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            } else {
                val photoFile = createImageFile() ?: return
                FileProvider.getUriForFile(
                    requireActivity(),
                    "${requireActivity().packageName}.provider",
                    photoFile
                )
            }

            if (photoURI == null) return

            currentPhotoUri = photoURI
            takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, photoURI)
            takePictureIntent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            requireActivity().grantUriPermission(
                takePictureIntent.resolveActivity(requireActivity().packageManager)?.packageName ?: "",
                photoURI,
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
            takePictureLauncher.launch(takePictureIntent)

        } catch (e: ActivityNotFoundException) {
            Toast.makeText(requireActivity(), "No camera app available", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @Throws(IOException::class)
    private fun createImageFile(): File? {
        val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
        val picturesDir = requireActivity().getExternalFilesDir(Environment.DIRECTORY_PICTURES)
        if (picturesDir != null && !picturesDir.exists()) picturesDir.mkdirs()
        return File.createTempFile("IMG_${timeStamp}_", ".jpg", picturesDir)
    }

    private val takePictureLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK) {
                currentPhotoUri?.let { path ->
                    val rotationFixedUri = fixImageRotationFromUri(requireActivity(), path)
                    if (rotationFixedUri != null) {
                        startUCropImage(rotationFixedUri)
                    } else {
                        startUCropImage(path)
                    }
                }
            } else {
                safeDeleteFile(currentPhotoUri.toString())
                currentPhotoUri = null
            }
        }

    private fun safeDeleteFile(pathUri: String?) {
        if (pathUri.isNullOrEmpty()) return
        try {
            val uri = Uri.parse(pathUri)
            when (uri.scheme) {
                "content" -> requireActivity().contentResolver.delete(uri, null, null)
                "file" -> {
                    val file = File(uri.path ?: return)
                    if (file.exists()) file.delete()
                }
                else -> {
                    val file = File(pathUri)
                    if (file.exists()) file.delete()
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun startUCropImage(uri: Uri) {
        try {
            val uniqueFileName = "cropped_${UUID.randomUUID()}.jpg"
            val destinationUri = Uri.fromFile(File(requireActivity().cacheDir, uniqueFileName))

            val intent = UCrop.of(uri, destinationUri)
                .withOptions(getUCropOptions())
                .getIntent(requireActivity())

            uCropActivityResult.launch(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun getUCropOptions(): UCrop.Options {
        return UCrop.Options().apply {
            setCompressionFormat(Bitmap.CompressFormat.JPEG)
            setCompressionQuality(100)
            setFreeStyleCropEnabled(true)
            setHideBottomControls(false)
            setShowCropGrid(true)
            setShowCropFrame(true)
        }
    }

    private val uCropActivityResult =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            try {
                if (result.resultCode == Activity.RESULT_OK && result.data != null) {
                    val uri = UCrop.getOutput(result.data!!)
                    if (uri != null) {
                        val file = getFileFromUriSafe(requireActivity(), uri)
                        if (file != null) {
                            handleCapturedPhoto(file.absolutePath)
                        } else {
                            ViewControll.showMessage(requireActivity(), "Image processing failed. Please try again.")
                        }
                    } else {
                        ViewControll.showMessage(requireActivity(), "Capture failed. Please try again.")
                    }
                } else if (result.resultCode == UCrop.RESULT_ERROR) {
                    val cropError = UCrop.getError(result.data!!)
                    ViewControll.showMessage(requireActivity(), "Crop failed: ${cropError?.message}")
                }
            } catch (e: Exception) {
                e.printStackTrace()
                ViewControll.showMessage(requireActivity(), "Capture failed. Please try again.")
            }
        }

    val selectImageLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            startUCropImage(it)
        }
    }

    private fun handleCapturedPhoto(filePath: String) {
        when (currentPhotoTarget) {
            PhotoTarget.SINGLE -> {
                singlePhotoPath = filePath
                binding.imgPreviewSingle.isVisible = true
                binding.btnChangeSingleOverlay.isVisible = true
                binding.llPromptSingle.isVisible = false
                Glide.with(requireActivity()).load(File(filePath)).into(binding.imgPreviewSingle)
            }
            PhotoTarget.BODY -> {
                bodyPhotoPath = filePath
                binding.imgPreviewBody.isVisible = true
                binding.btnChangeBodyOverlay.isVisible = true
                binding.llPromptBody.isVisible = false
                Glide.with(requireActivity()).load(File(filePath)).into(binding.imgPreviewBody)
            }
            PhotoTarget.PALLU -> {
                palluPhotoPath = filePath
                binding.imgPreviewPallu.isVisible = true
                binding.btnChangePalluOverlay.isVisible = true
                binding.llPromptPallu.isVisible = false
                Glide.with(requireActivity()).load(File(filePath)).into(binding.imgPreviewPallu)
            }
        }
    }

    private fun getFileFromUriSafe(context: Context, uri: Uri): File? {
        try {
            val path = FileUtils.getPath(context, uri)
            if (!path.isNullOrBlank()) {
                val file = File(path)
                if (file.exists() && file.length() > 0) {
                    return file
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return copyUriToCacheFileSafe(context, uri)
    }

    private fun copyUriToCacheFileSafe(context: Context, uri: Uri): File? {
        return try {
            val inputStream = context.contentResolver.openInputStream(uri) ?: return null
            val file = File(context.cacheDir, "final_${System.currentTimeMillis()}.jpg")
            FileOutputStream(file).use { output ->
                inputStream.use { input ->
                    input.copyTo(output)
                }
            }
            if (file.exists() && file.length() > 0) file else null
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }

    private fun fixImageRotationFromUri(context: Context, imageUri: Uri): Uri? {
        return try {
            val inputStream = context.contentResolver.openInputStream(imageUri) ?: return imageUri
            val tempFile = File(context.cacheDir, "fixed_${System.currentTimeMillis()}.jpg")
            FileOutputStream(tempFile).use { out -> inputStream.copyTo(out) }
            inputStream.close()

            val exif = ExifInterface(tempFile.absolutePath)
            val orientation = exif.getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            )

            val rotationDegrees = when (orientation) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90
                ExifInterface.ORIENTATION_ROTATE_180 -> 180
                ExifInterface.ORIENTATION_ROTATE_270 -> 270
                else -> 0
            }

            val isFrontCamera = isFrontCameraImage(tempFile.absolutePath)

            if (rotationDegrees == 0 && !isFrontCamera) {
                return Uri.fromFile(tempFile)
            }

            val bitmap = BitmapFactory.decodeFile(tempFile.absolutePath)
            val matrix = Matrix()
            if (rotationDegrees != 0) matrix.postRotate(rotationDegrees.toFloat())
            if (isFrontCamera) {
                matrix.postScale(-1f, 1f, bitmap.width / 2f, bitmap.height / 2f)
            }
            val rotatedBitmap = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)

            FileOutputStream(tempFile).use { out ->
                rotatedBitmap.compress(Bitmap.CompressFormat.JPEG, 100, out)
            }

            val newExif = ExifInterface(tempFile.absolutePath)
            newExif.setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL.toString())
            newExif.saveAttributes()

            Uri.fromFile(tempFile)
        } catch (e: Exception) {
            e.printStackTrace()
            imageUri
        }
    }

    private fun isFrontCameraImage(imagePath: String): Boolean {
        return try {
            val exif = ExifInterface(imagePath)
            val orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED)
            if (isFrontCameraImageForSamsung(imagePath)) {
                orientation == ExifInterface.ORIENTATION_ROTATE_270 || orientation == ExifInterface.ORIENTATION_ROTATE_90
            } else {
                false
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    private fun isFrontCameraImageForSamsung(imagePath: String): Boolean {
        val exif = ExifInterface(imagePath)
        val orientation = exif.getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL
        )
        return orientation == ExifInterface.ORIENTATION_FLIP_HORIZONTAL ||
                orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
                orientation == ExifInterface.ORIENTATION_TRANSVERSE
    }

    private fun processFinalGeneration() {
        val subcategoryId = selectedSubcategoryId
        if (subcategoryId == null) {
            ViewControll.showMessage(
                requireActivity(),
                "Please select a product type before uploading"
            )
            return
        }
        if (currentMode == UploadMode.SINGLE) {
            val photoPath = singlePhotoPath
            if (photoPath.isNullOrEmpty()) {
                ViewControll.showMessage(requireActivity(), "Please select or take a photo first")
                return
            }
            val style = selectedStyleId ?: selectedStyleLabel
            val uploadPhotoDialog = UploadPhotoDialog(
                selectedPhotoPath = photoPath,
                subcategoryId = subcategoryId,
                sareeStyleId = style,
                secondaryPhotoPath = null
            ) { resultUrl ->
                lastGeneratedResultUrl = resultUrl
                binding.llAddProduct.isVisible = true
                binding.llUploadProduct.isVisible = false
                resetSelectCatSKUDetails()
                initViewAddProduct(resultUrl)
            }
            uploadPhotoDialog.show(childFragmentManager, "UploadPhotoDialog")
        } else { // Separate / Multiple Mode
            val bodyPath = bodyPhotoPath
            val palluPath = palluPhotoPath
            if (bodyPath.isNullOrEmpty() && palluPath.isNullOrEmpty()) {
                ViewControll.showMessage(requireActivity(), "Please upload at least Body or Pallu image")
                return
            }
            val primaryPath = bodyPath ?: palluPath ?: return
            val secondaryPath = if (!bodyPath.isNullOrEmpty() && !palluPath.isNullOrEmpty()) palluPath else null
            val style = selectedStyleId ?: selectedStyleLabel
            val uploadPhotoDialog = UploadPhotoDialog(
                selectedPhotoPath = primaryPath,
                subcategoryId = subcategoryId,
                sareeStyleId = style,
                secondaryPhotoPath = secondaryPath
            ) { resultUrl ->
                lastGeneratedResultUrl = resultUrl
                binding.llAddProduct.isVisible = true
                binding.llUploadProduct.isVisible = false
                resetSelectCatSKUDetails()
                initViewAddProduct(resultUrl)
            }
            uploadPhotoDialog.show(childFragmentManager, "UploadPhotoDialog")
        }
    }

    private fun initViewAddProduct(resultUrl: String) {
        try {
            Glide.with(requireActivity())
                .load(resultUrl)
                .placeholder(ViewControll.setLoaderDrawble(requireActivity()))
                .into(binding.imgTryonResult)
        } catch (e: Exception) {
            e.printStackTrace()
        }
        binding.btnCancel.setOnClickListener(this)
        binding.btnUpload.setOnClickListener(this)
        binding.btnUpload.setTextColor(ContextCompat.getColor(requireActivity(), R.color.white))
        binding.btnCancel.setTextColor(ContextCompat.getColor(requireActivity(), R.color.white))
    }

    private fun checkValidation(): Boolean {
        if (binding.etSkuNo.text.trim().isEmpty()) {
            ViewControll.showMessage(requireActivity(), "Please add SKU No")
            return false
        } else if (binding.etPrice.text.trim().isEmpty()) {
            ViewControll.showMessage(requireActivity(), "Please add price")
            return false
        } else if (binding.etOfferPrice.text.trim().isEmpty()) {
            ViewControll.showMessage(requireActivity(), "Please add offer price")
            return false
        } else {
            return true
        }
    }

    private fun uploadVastraProductAPI() {
        val skuNo = binding.etSkuNo.text.trim().toString()
        val price = binding.etPrice.text.trim().toString().toIntOrNull() ?: 0
        val offerPrice = binding.etOfferPrice.text.trim().toString().toIntOrNull() ?: 0
        LoaderManager.show(requireActivity(), requireActivity().findViewById(android.R.id.content), true)
        LoaderManager.setMessage("Adding Product...")
        productUploadViewmodel.finalizeProduct(skuNo, price, offerPrice) { success, errorMsg ->
            LoaderManager.remove(requireActivity())
            if (success) {
                ViewControll.showMessage(requireActivity(), "Product added successfully")
                binding.llUploadProduct.isVisible = true
                binding.llAddProduct.isVisible = false
                showSubStep(SubStep.MODE_SELECTION)
                (activity as? DashBoardActivity)?.navigateToProductFrag()
            } else {
                ViewControll.showMessage(requireActivity(), errorMsg)
            }
        }
    }

    private fun getSareeStylesData() {
        productUploadViewmodel.fetchSareeStyles()
        productUploadViewmodel.sareeStyles.observe(viewLifecycleOwner) { styles ->
            if (styles != null) {
                availableStyles = styles
                if (currentSubStep == SubStep.STYLE_SELECTION) {
                    updateStyleSelectionUi()
                }
            }
        }
    }

    private fun updateStyleSelectionUi() {
        currentFilteredStyles = if (currentMode == UploadMode.MULTIPLE) {
            availableStyles.filter { it.supportsTwoInput }
        } else {
            availableStyles
        }

        if (currentFilteredStyles.isNotEmpty()) {
            val style1 = currentFilteredStyles[0]
            binding.tvStyle1Label.text = style1.label
            if (!style1.previewUrl.isNullOrEmpty()) {
                Glide.with(requireActivity()).load(style1.previewUrl).into(binding.imgStyle1Preview)
            }

            if (currentFilteredStyles.size > 1) {
                val style2 = currentFilteredStyles[1]
                binding.cardStyle2.isVisible = true
                binding.tvStyle2Label.text = style2.label
                if (!style2.previewUrl.isNullOrEmpty()) {
                    Glide.with(requireActivity()).load(style2.previewUrl).into(binding.imgStyle2Preview)
                }
            } else {
                binding.cardStyle2.isVisible = false
            }

            val defaultStyleLabel = currentFilteredStyles.firstOrNull()?.label ?: "Nivi"
            selectStyleByLabel(defaultStyleLabel)
        } else {
            // Fallback default UI labels
            binding.tvStyle1Label.text = "Nivi"
            binding.tvStyle2Label.text = "Seedha Pallu"
            binding.cardStyle2.isVisible = true
            selectStyleByLabel("Nivi")
        }
    }

    private fun selectStyleByLabel(styleLabel: String) {
        selectedStyleLabel = styleLabel
        val purpleColor = android.graphics.Color.parseColor("#6C5CE7")
        val strokeWidthPx = (2.5f * resources.displayMetrics.density).toInt()

        val label1 = binding.tvStyle1Label.text.toString()
        if (styleLabel.equals(label1, ignoreCase = true)) {
            binding.cardStyle1.strokeWidth = strokeWidthPx
            binding.cardStyle1.strokeColor = purpleColor
            binding.imgCheckStyle1.isVisible = true

            binding.cardStyle2.strokeWidth = 0
            binding.imgCheckStyle2.isVisible = false
        } else {
            binding.cardStyle2.strokeWidth = strokeWidthPx
            binding.cardStyle2.strokeColor = purpleColor
            binding.imgCheckStyle2.isVisible = true

            binding.cardStyle1.strokeWidth = 0
            binding.imgCheckStyle1.isVisible = false
        }
    }

    private fun getSubcategoryData() {
        productUploadViewmodel.fetchSubcategories("women")
        productUploadViewmodel.subcategories.observe(viewLifecycleOwner) { subcategoryList ->
            if (subcategoryList != null && subcategoryList.isNotEmpty()) {
                setSubcategorySpinner(subcategoryList)
            }
        }
        productUploadViewmodel.error.observe(viewLifecycleOwner) { errorMsg ->
            if (errorMsg != null) {
                ViewControll.showSnackErrorMsg(requireActivity(), errorMsg)
            }
        }
    }

    private fun setSubcategorySpinner(subcategoryList: List<MerchantCatalogSubcategory>) {
        val nameList = subcategoryList.map { it.name }
        val adapter = ArrayAdapter(requireActivity(), R.layout.item_spinner_text, nameList)
        binding.materialSpinnerPalluType.setAdapter(adapter)
        binding.materialSpinnerPalluType.setOnItemClickListener { _, _, position, _ ->
            selectedSubcategoryId = subcategoryList[position].id
        }
        binding.materialSpinnerPalluType.setDropDownBackgroundDrawable(
            ContextCompat.getDrawable(requireActivity(), R.drawable.bg_dropdown_white)
        )

        if (subcategoryList.isNotEmpty()) {
            selectedSubcategoryId = subcategoryList[0].id
            binding.materialSpinnerPalluType.setText(subcategoryList[0].name, false)
        }

        binding.materialSpinnerPalluType.isEnabled = subcategoryList.size > 1
    }

    fun handleBack() {
        if (binding.llAddProduct.isVisible) {
            showCancleUploadAlertDialog(lastGeneratedResultUrl)
        } else {
            when (currentSubStep) {
                SubStep.STYLE_SELECTION -> {
                    if (currentMode == UploadMode.SINGLE) {
                        showSubStep(SubStep.SINGLE_UPLOAD)
                    } else {
                        showSubStep(SubStep.MULTIPLE_UPLOAD)
                    }
                }
                SubStep.SINGLE_UPLOAD, SubStep.MULTIPLE_UPLOAD -> {
                    showSubStep(SubStep.MODE_SELECTION)
                }
                SubStep.MODE_SELECTION -> {
                    (activity as? DashBoardActivity)?.finish()
                }
            }
        }
    }

    private fun showCancleUploadAlertDialog(tryOnResultUrl: String) {
        val showErrorAlertDialog = ShowErrorAlertDialog(
            ShowErrorAlertDialog.ImageSourceType.FromUrl(tryOnResultUrl),
            getString(R.string.discard_upload),
            getString(R.string.discard_upload_alert),
            getString(R.string.stay),
            getString(R.string.discard)
        ) {
            productUploadViewmodel.resetGenerateState()
            lastGeneratedResultUrl = ""
            binding.llAddProduct.isVisible = false
            binding.llUploadProduct.isVisible = true
            showSubStep(SubStep.MODE_SELECTION)
        }
        showErrorAlertDialog.show(childFragmentManager, "ShowErrorAlertDialog")
    }

    private fun resetSelectCatSKUDetails() {
        binding.etSkuNo.text.clear()
        binding.etPrice.text.clear()
        binding.etOfferPrice.text.clear()
    }

    private fun isSubcategorySelected(): Boolean {
        if (selectedSubcategoryId == null) {
            ViewControll.showMessage(requireActivity(), "Please select a product type before upload")
            return false
        }
        return true
    }

    companion object {
        @JvmStatic
        fun newInstance() = UploadVastraFragment()
    }

    override fun onClick(v: View?) {
        val id = v?.id

        // Sub-step 0: Mode Selection
        if (id == R.id.card_mode_single) {
            currentMode = UploadMode.SINGLE
            showSubStep(SubStep.SINGLE_UPLOAD)
        }
        if (id == R.id.card_mode_multiple) {
            currentMode = UploadMode.MULTIPLE
            showSubStep(SubStep.MULTIPLE_UPLOAD)
        }

        // Sub-step 1A: Single Upload
        if (id == R.id.card_upload_single) {
            showImageOptionDialog(PhotoTarget.SINGLE)
        }
        if (id == R.id.btn_back_single || id == R.id.btn_back_single_bottom) {
            showSubStep(SubStep.MODE_SELECTION)
        }
        if (id == R.id.btn_continue_single) {
            if (singlePhotoPath.isNullOrEmpty()) {
                ViewControll.showMessage(requireActivity(), "Please upload a saree image first")
            } else if (isSubcategorySelected()) {
                showSubStep(SubStep.STYLE_SELECTION)
            }
        }

        // Sub-step 1B: Separate / Multiple Upload
        if (id == R.id.card_upload_body) {
            showImageOptionDialog(PhotoTarget.BODY)
        }
        if (id == R.id.card_upload_pallu) {
            showImageOptionDialog(PhotoTarget.PALLU)
        }
        if (id == R.id.btn_back_multiple || id == R.id.btn_back_multiple_bottom) {
            showSubStep(SubStep.MODE_SELECTION)
        }
        if (id == R.id.btn_continue_multiple) {
            if (bodyPhotoPath.isNullOrEmpty() && palluPhotoPath.isNullOrEmpty()) {
                ViewControll.showMessage(requireActivity(), "Please upload Body or Pallu image")
            } else if (isSubcategorySelected()) {
                showSubStep(SubStep.STYLE_SELECTION)
            }
        }

        // Sub-step 2: Style Selection
        if (id == R.id.btn_back_style) {
            if (currentMode == UploadMode.SINGLE) {
                showSubStep(SubStep.SINGLE_UPLOAD)
            } else {
                showSubStep(SubStep.MULTIPLE_UPLOAD)
            }
        }
        if (id == R.id.card_style_1) {
            val label = currentFilteredStyles.getOrNull(0)?.label ?: binding.tvStyle1Label.text.toString()
            selectStyleByLabel(label)
        }
        if (id == R.id.card_style_2) {
            val label = currentFilteredStyles.getOrNull(1)?.label ?: binding.tvStyle2Label.text.toString()
            selectStyleByLabel(label)
        }
        if (id == R.id.btn_apply_style) {
            processFinalGeneration()
        }

        // Step 2 (Result / Add Product view)
        if (id == R.id.btn_cancel) {
            showCancleUploadAlertDialog(lastGeneratedResultUrl)
        }
        if (id == R.id.btn_upload) {
            if (checkValidation()) {
                uploadVastraProductAPI()
            }
        }
        if (id == R.id.img_profile) {
            val intent = Intent(requireActivity(), ProfileActivity::class.java)
            startActivity(intent)
            requireActivity().overridePendingTransition(R.anim.fade_and_scale_in, R.anim.fade_and_scale_out)
        }
    }
}
