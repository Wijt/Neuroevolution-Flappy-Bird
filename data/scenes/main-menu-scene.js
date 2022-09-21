class MainMenuScene extends Scene {
    constructor() {
        super();

        this.playButton;
        this.trainButton;
        this.watchButton;
    }

    start() {
        super.start();

        this.playButton = createButton('play');
        this.playButton.addClass("main-menu-button");
        this.playButton.size("15rem", "5rem");
        // this couldn't be done with css because of the p5.js cannot detect the size of the button when positioning it
        this.playButton.position(innerWidth/2-this.playButton.width/2, innerHeight/2 - this.playButton.height/2 - 120);
        this.playButton.mouseClicked(() => {
            this.sceneManager.openScene(PLAY_SCENE);
        });

        this.trainButton = createButton('train');
        this.trainButton.addClass("main-menu-button");
        this.trainButton.size("15rem", "5rem");
        this.trainButton.position(innerWidth/2 - this.trainButton.width/2, innerHeight/2 - this.trainButton.height/2);
        this.trainButton.mouseClicked(() => {
            this.sceneManager.openScene(TRAIN_SCENE);
        });

        this.watchButton = createButton('watch');
        this.watchButton.addClass("main-menu-button");
        this.watchButton.size("15rem", "5rem"); 
        this.watchButton.position(innerWidth/2- this.watchButton.width/2, innerHeight/2 + this.watchButton.height/2 + 40);
        this.watchButton.mouseClicked(() => {
            this.sceneManager.openScene(WATCH_SCENE);
        });
    }

    update() {
        super.update();
    }

    draw() {      
        background(color("#99CFCF"));

        // draw the background image with the correct scaling
        var hRatio = width  / assets["main_bg"].width;
        var vRatio =  height / assets["main_bg"].height;
        var ratio  = min(hRatio, vRatio);
        var imgWidth = assets["main_bg"].width * ratio;
        var imgHeight = assets["main_bg"].height * ratio;
        var centerShift_x = (width - imgWidth) / 2;
        var centerShift_y = (height - imgHeight) / 2;  
        image(assets["main_bg"], centerShift_x, centerShift_y, imgWidth, imgHeight);  
    
         // draw the bird image on left with the correct scaling
        hRatio = width  / assets["main_bird"].width;
        vRatio =  height / assets["main_bird"].height;
        ratio  = min(hRatio, vRatio);
        imgWidth = assets["main_bird"].width * ratio;
        imgHeight = assets["main_bird"].height * ratio;
        image(
            assets["main_bird"],
            imgWidth * -0.50, // translate the image to the left by 50% of its width
            ((height - imgHeight) * 0.50) + ((height - imgHeight) * sin(frameCount * 0.05) * 0.45), // translate the image up and down by 45% of its height with a sin wave
            imgWidth,
            imgHeight
        );  
    }

    exit() {
        super.exit();
        this.playButton.remove();
        this.trainButton.remove();
        this.watchButton.remove();
    }
}